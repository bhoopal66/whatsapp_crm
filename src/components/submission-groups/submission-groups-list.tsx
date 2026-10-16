'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Archive, FolderKanban, Loader2, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { relativeActivity } from '@/lib/groups/ui';
import {
  appendPage,
  listUrl,
  parseSgList,
  type SgListItem,
} from '@/lib/submission-groups/ui';
import { cn } from '@/lib/utils';

type Tab = 'active' | 'ended';

const SEARCH_DEBOUNCE_MS = 300;

interface Loaded {
  groups: SgListItem[];
  next: string | null;
  failed: boolean;
}

/** /submission-groups — Active and Ended tabs, searched server-side. */
export function SubmissionGroupsList() {
  const t = useTranslations('SubmissionGroups');
  const [tab, setTab] = useState<Tab>('active');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (status: Tab, q: string) => {
    const mine = ++seq.current;
    setLoaded(null);
    try {
      const res = await fetch(listUrl(status, q, null), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const page = parseSgList(await res.json());
      if (mine === seq.current)
        setLoaded({
          groups: page.groups,
          next: page.next_cursor,
          failed: false,
        });
    } catch {
      if (mine === seq.current)
        setLoaded({ groups: [], next: null, failed: true });
    }
  }, []);

  useEffect(() => {
    void load(tab, debounced);
  }, [load, tab, debounced]);

  const loadMore = async () => {
    if (!loaded?.next) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const res = await fetch(listUrl(tab, debounced, loaded.next), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const page = parseSgList(await res.json());
      if (mine === seq.current)
        setLoaded((prev) =>
          prev
            ? {
                groups: appendPage(prev.groups, page.groups),
                next: page.next_cursor,
                failed: false,
              }
            : prev
        );
    } catch {
      // Keep what is listed; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  const searching = debounced.trim() !== '';
  const now = new Date();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <div className="min-w-0">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="active">{t('tabs.active')}</TabsTrigger>
            <TabsTrigger value="ended">{t('tabs.ended')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-72">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            className="pl-8"
          />
        </div>
      </div>

      {!loaded ? (
        <ul className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="border-border bg-card flex items-center gap-3 rounded-xl border p-4"
            >
              <span className="bg-muted size-10 shrink-0 animate-pulse rounded-full" />
              <span className="flex-1 space-y-2">
                <span className="bg-muted block h-4 w-1/3 animate-pulse rounded" />
                <span className="bg-muted block h-3 w-1/2 animate-pulse rounded" />
              </span>
            </li>
          ))}
        </ul>
      ) : loaded.failed ? (
        <div className="flex items-center gap-3">
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(tab, debounced)}
          >
            {t('retry')}
          </Button>
        </div>
      ) : loaded.groups.length === 0 ? (
        searching ? (
          <p className="text-muted-foreground text-sm">
            {t('noMatches', { query: debounced.trim() })}
          </p>
        ) : (
          <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
            <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
              <FolderKanban className="size-5" aria-hidden />
            </span>
            <p className="font-semibold">
              {tab === 'active' ? t('emptyActiveTitle') : t('emptyEndedTitle')}
            </p>
            <p className="text-muted-foreground max-w-md text-sm">
              {tab === 'active' ? t('emptyActiveBody') : t('emptyEndedBody')}
            </p>
          </div>
        )
      ) : (
        <>
          <ul className="space-y-2">
            {loaded.groups.map((g) => (
              <Row key={g.id} group={g} now={now} />
            ))}
          </ul>
          {loaded.next && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore && (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                )}
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ group: g, now }: { group: SgListItem; now: Date }) {
  const t = useTranslations('SubmissionGroups');
  const locale = useLocale();
  const ended = g.status === 'ENDED';
  const at = ended ? g.ended_at : g.last_activity_at;
  const activity = relativeActivity(at, now);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const when =
    activity.unit === 'none'
      ? null
      : activity.unit === 'now'
        ? t('justNow')
        : activity.unit === 'date'
          ? activity.date.toLocaleDateString(locale, {
              day: 'numeric',
              month: 'short',
              year:
                activity.date.getFullYear() === now.getFullYear()
                  ? undefined
                  : 'numeric',
            })
          : rtf.format(-activity.value, activity.unit);
  const customer = g.contact
    ? g.contact.name || g.contact.phone || '—'
    : t('contactRemoved');
  const number = g.channel ? (g.channel.label ?? '') : t('numberRemoved');

  return (
    <li>
      <Link
        href={`/submission-groups/${g.id}`}
        className={cn(
          'border-border bg-card hover:bg-muted/60 flex items-center gap-3 rounded-xl border p-3 transition-colors sm:p-4',
          ended && 'opacity-80'
        )}
      >
        <span
          className="bg-wa-green/15 text-wa-green flex size-10 shrink-0 items-center justify-center rounded-full"
          aria-hidden
        >
          <FolderKanban className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{g.submission_ref}</span>
            {g.subject && (
              <span className="text-muted-foreground truncate text-sm">
                {g.subject}
              </span>
            )}
            {g.pending && !ended && (
              <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 [[data-mode=dark]_&]:text-amber-300">
                {t('pendingBadge')}
              </span>
            )}
            {ended && g.archive && (
              <span className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                <Archive className="size-3" aria-hidden />
                {t('archiveBadge')}
              </span>
            )}
            {g.my_label && (
              <span className="bg-wa-green/15 text-wa-green shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                {t(`labels.${g.my_label}`)}
              </span>
            )}
          </span>
          <span className="text-muted-foreground block truncate text-xs sm:text-sm">
            {[customer, number].filter(Boolean).join(' · ')}
          </span>
        </span>
        {when && (
          <span className="text-muted-foreground hidden shrink-0 text-xs sm:block">
            {ended ? t('endedAt', { when }) : when}
          </span>
        )}
      </Link>
    </li>
  );
}
