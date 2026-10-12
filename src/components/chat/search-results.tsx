'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Hash, Lock, MessageCircle, SearchX } from 'lucide-react';

import { searchMessages, type ChatErrorKey, type SearchHit } from '@/lib/chat';
import {
  groupSearchHits,
  matchPeople,
  queryTerms,
  searchHitHref,
  searchSnippet,
  snippetParts,
} from '@/lib/chat/search-view';
import {
  avatarTint,
  channelDisplayName,
  chatErrorKey,
  formatClock,
  initialOf,
} from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';

const CHIP =
  'rounded px-1 font-semibold text-[#0E7C5A] bg-emerald-50 [[data-mode=dark]_&]:bg-emerald-500/15 [[data-mode=dark]_&]:text-emerald-300';
const MARK =
  'rounded-sm bg-amber-200/80 px-0.5 text-inherit [[data-mode=dark]_&]:bg-amber-400/30';
const HEADING =
  'text-muted-foreground px-1 pb-2 text-[11px] font-semibold tracking-[0.14em] uppercase';

const dayOf = (ts: string) => {
  const d = new Date(ts.replace(' ', 'T'));
  return Number.isNaN(d.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
      }).format(d);
};

/** /chat?search=<q>: matching people, then message hits grouped by channel. */
export function SearchResults({ query }: { query: string }) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const [result, setResult] = useState<{
    q: string;
    hits: SearchHit[];
    error: ChatErrorKey | null;
  } | null>(null);

  useEffect(() => {
    if (!ws.accountId) return;
    let off = false;
    searchMessages(ws.sb, { accountId: ws.accountId, query, limit: 50 })
      .then((hits) => !off && setResult({ q: query, hits, error: null }))
      .catch(
        (err) =>
          !off && setResult({ q: query, hits: [], error: chatErrorKey(err) })
      );
    return () => {
      off = true;
    };
  }, [ws.sb, ws.accountId, query]);

  const terms = useMemo(() => queryTerms(query), [query]);
  const people = useMemo(
    () =>
      matchPeople(
        ws.people.filter((p) => p.userId !== ws.userId),
        query
      ),
    [ws.people, ws.userId, query]
  );
  const channelsById = useMemo(
    () => new Map((ws.channels ?? []).map((c) => [c.id, c])),
    [ws.channels]
  );
  const loading = !result || result.q !== query;
  const groups = loading ? [] : groupSearchHits(result.hits);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <h1 className="text-foreground text-lg font-semibold">
          {t('search.title', { q: query })}
        </h1>

        {people.length > 0 && (
          <section aria-label={t('search.people')}>
            <p className={HEADING}>{t('search.people')}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {people.map((p) => (
                <li key={p.userId}>
                  <Link
                    href={`/chat?dm=${encodeURIComponent(p.userId)}`}
                    className="bg-card hover:bg-muted/60 flex items-center gap-3 rounded-lg border px-3 py-2"
                  >
                    <span
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold',
                        avatarTint(p.userId)
                      )}
                    >
                      {initialOf(p.fullName)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {p.fullName}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t('search.message')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label={t('search.messages')} aria-busy={loading}>
          <p className={HEADING}>
            {t('search.messages')}
            {!loading && result.hits.length > 0 && (
              <span className="ml-2 tracking-normal normal-case">
                {t('search.count', { count: result.hits.length })}
              </span>
            )}
          </p>
          {loading ? (
            <div className="space-y-3" aria-label={t('search.searching')}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="bg-muted h-16 animate-pulse rounded-lg"
                />
              ))}
            </div>
          ) : result.error ? (
            <p className="text-destructive text-sm">
              {t(`errors.${result.error}`)}
            </p>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
              <SearchX className="text-muted-foreground size-8" aria-hidden />
              <p className="text-foreground text-sm font-medium">
                {t('search.none', { q: query })}
              </p>
              <p className="text-muted-foreground max-w-sm text-xs">
                {t('search.noneHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {groups.map((g) => {
                const channel = channelsById.get(g.channelId);
                const name = channel
                  ? channelDisplayName(
                      channel,
                      ws.userId ?? '',
                      ws.peopleById,
                      t('unknownPerson')
                    )
                  : t('search.unknownChannel');
                const Icon =
                  channel?.kind === 'dm'
                    ? MessageCircle
                    : channel?.kind === 'private'
                      ? Lock
                      : Hash;
                return (
                  <div key={g.channelId} className="rounded-lg border">
                    <Link
                      href={`/chat/${g.channelId}`}
                      className="bg-muted/40 hover:bg-muted flex items-center gap-2 rounded-t-lg border-b px-3 py-2 text-sm font-semibold"
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                    </Link>
                    <ul className="divide-y">
                      {g.hits.map((h) => (
                        <SearchHitRow key={h.messageId} hit={h} terms={terms} />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SearchHitRow({
  hit,
  terms,
}: {
  hit: SearchHit;
  terms: readonly string[];
}) {
  const t = useTranslations('Chat');
  const { peopleById, people } = useChatWorkspaceContext();
  const author = hit.authorId
    ? peopleById.get(hit.authorId.toLowerCase())
    : undefined;
  const snippet = searchSnippet(hit.body, terms);
  return (
    <li>
      <Link
        href={searchHitHref(hit)}
        className="hover:bg-muted/40 flex gap-3 px-3 py-2.5"
      >
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold',
            avatarTint(hit.authorId)
          )}
        >
          {initialOf(author?.fullName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-sm">
            <span className="truncate font-semibold">
              {hit.authorId
                ? (author?.fullName ?? t('unknownPerson'))
                : t('timeline.system')}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {dayOf(hit.createdAt)} {formatClock(hit.createdAt)}
            </span>
            {hit.threadRootId && (
              <span className="text-muted-foreground shrink-0 text-xs">
                · {t('search.inThread')}
              </span>
            )}
          </span>
          <span className="text-foreground/90 mt-0.5 block text-sm break-words whitespace-pre-wrap">
            {snippet.before && '…'}
            {snippetParts(snippet.text, terms, people).map((s, i) =>
              s.type === 'text' ? (
                s.hit ? (
                  <mark key={i} className={MARK}>
                    {s.text}
                  </mark>
                ) : (
                  <span key={i}>{s.text}</span>
                )
              ) : s.type === 'mention' ? (
                <span key={i} className={CHIP}>
                  @{s.name ?? t('unknownPerson')}
                </span>
              ) : (
                <span key={i} className={CHIP}>
                  @{s.kind}
                </span>
              )
            )}
            {snippet.after && '…'}
          </span>
        </span>
      </Link>
    </li>
  );
}
