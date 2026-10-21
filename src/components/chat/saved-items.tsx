'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Bookmark,
  Hash,
  Lock,
  MessageCircle,
  User,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { mentionSegments, setSaved, type ChannelKind } from '@/lib/chat';
import {
  countSaved,
  emitSavedChange,
  listSaved,
  onSavedChange,
  savedHref,
  savedTombstone,
  type SavedItem,
} from '@/lib/chat/saved';
import {
  avatarTint,
  boldSegments,
  channelDisplayName,
  initialOf,
} from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';

const CHIP = 'rounded px-1 font-semibold bg-primary-soft text-primary';

const KIND_ICON: Record<ChannelKind, typeof Hash> = {
  team: Hash,
  private: Lock,
  deal_room: MessageCircle,
  dm: User,
};

/**
 * The sidebar's Saved count: re-read on navigation, on window focus and
 * whenever a screen reports a change (saves have no realtime feed).
 */
export function useSavedCount(): number | null {
  const { sb, accountId } = useChatWorkspaceContext();
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let off = false;
    const load = () =>
      void countSaved(sb, accountId)
        .then((n) => !off && setCount(n))
        .catch(() => {});
    load();
    const unsubscribe = onSavedChange(load);
    window.addEventListener('focus', load);
    return () => {
      off = true;
      unsubscribe();
      window.removeEventListener('focus', load);
    };
  }, [sb, accountId, pathname]);
  return count;
}

function SavedRow({
  item,
  onRemove,
}: {
  item: SavedItem;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations('Chat');
  const format = useFormatter();
  const { people, peopleById, userId } = useChatWorkspaceContext();
  const m = item.message;
  const system = m.authorKind === 'system';
  const author = system
    ? t('timeline.system')
    : (m.authorId && peopleById.get(m.authorId.toLowerCase())?.fullName) ||
      t('unknownPerson');
  const where = item.channel
    ? channelDisplayName(
        item.channel,
        userId ?? '',
        peopleById,
        t('unknownPerson')
      )
    : '';
  const Icon = item.channel ? (KIND_ICON[item.channel.kind] ?? Hash) : Hash;
  const tomb = savedTombstone(m);
  const when = new Date(m.createdAt.replace(' ', 'T'));

  let snippet: React.ReactNode;
  if (tomb)
    snippet = (
      <span className="text-muted-foreground italic">
        {tomb === 'deleted' ? t('timeline.deleted') : t('saved.erased')}
      </span>
    );
  else if (!m.body.trim())
    snippet = (
      <span className="text-muted-foreground italic">{t('saved.noText')}</span>
    );
  else if (system)
    snippet = boldSegments(m.body).map((s, i) =>
      s.bold ? <strong key={i}>{s.text}</strong> : s.text
    );
  else
    snippet = mentionSegments(m.body, people).map((s, i) =>
      s.type === 'text' ? (
        s.text
      ) : (
        <span key={i} className={CHIP}>
          @{s.type === 'mention' ? (s.name ?? t('unknownPerson')) : s.kind}
        </span>
      )
    );

  return (
    <li className="hover:bg-muted/40 flex items-start gap-3 rounded-lg border px-3 py-2.5">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold',
          system ? 'bg-muted text-muted-foreground' : avatarTint(m.authorId)
        )}
        aria-hidden
      >
        {system ? '·' : initialOf(author)}
      </span>
      <Link href={savedHref(m)} className="min-w-0 flex-1">
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          <Icon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{where}</span>
          {m.threadRootId && (
            <span className="shrink-0">· {t('saved.inThread')}</span>
          )}
        </span>
        <span className="block text-sm">
          <span className="font-bold">{author}</span>
          {!Number.isNaN(when.getTime()) && (
            <span className="text-muted-foreground">
              {' · '}
              <time dateTime={m.createdAt}>
                {format.dateTime(when, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </time>
            </span>
          )}
        </span>
        <span className="line-clamp-2 block text-sm break-words whitespace-pre-wrap">
          {snippet}
        </span>
      </Link>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onRemove(m.id)}
        className="shrink-0"
      >
        {t('saved.remove')}
      </Button>
    </li>
  );
}

/** /chat/saved: the viewer's saved messages in this workspace, newest saved first. */
export function SavedItems() {
  const t = useTranslations('Chat');
  const { sb, accountId, fail } = useChatWorkspaceContext();
  const [items, setItems] = useState<SavedItem[] | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      setItems(await listSaved(sb, accountId));
    } catch (err) {
      setItems((prev) => prev ?? []);
      fail(err);
    }
  }, [sb, accountId, fail]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const remove = async (id: string) => {
    setItems((list) => list && list.filter((i) => i.messageId !== id));
    try {
      await setSaved(sb, id, false);
      toast.success(t('actions.unsaved'));
    } catch (err) {
      fail(err);
      void load();
    } finally {
      emitSavedChange();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          href="/chat"
          aria-label={t('channel.back')}
          className="hover:bg-muted -ml-1 flex size-8 items-center justify-center rounded-md lg:hidden"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Bookmark className="text-primary size-4" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold">{t('saved.title')}</h1>
          <p className="text-muted-foreground truncate text-xs">
            {items
              ? t('saved.count', { count: items.length })
              : t('saved.loading')}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {items === null ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-muted h-16 animate-pulse rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground py-12 text-center text-sm">
            {t('saved.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <SavedRow
                key={item.messageId}
                item={item}
                onRemove={(id) => void remove(id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
