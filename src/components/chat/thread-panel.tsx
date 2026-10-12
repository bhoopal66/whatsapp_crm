'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import {
  applyMessageEvent,
  applyReactionEvent,
  attachmentsFor,
  createTimeline,
  isGroupedWithPrevious,
  listMessages,
  MESSAGE_COLUMNS,
  reactionsFor,
  sharedCards,
  threadSummaries,
  toChatError,
  toChatMessage,
  toggleReaction,
  withDetails,
  type SharedCard,
  type TimelineState,
} from '@/lib/chat';
import { offersBroadcasts } from '@/lib/chat/composer-input';
import { channelDisplayName } from '@/lib/chat/view';

import { useChatWorkspaceContext } from './chat-context';
import { Composer } from './composer';
import type { RowActionContext } from './message-actions';
import { MessageRow } from './message-row';
import { useWriteBlock } from './use-write-block';

/** Replies read at once; a longer thread shows its latest ones. */
const REPLY_LIMIT = 200;

export interface ThreadPanelProps {
  channelId: string;
  rootId: string;
  onClose: () => void;
}

/**
 * The right column (a full-screen sheet below lg): the root message,
 * its replies and the thread composer. Live through the workspace's
 * one subscription: the root in a main-list timeline (so replies bump
 * its summary) and the replies in a thread-mode one.
 */
export function ThreadPanel({ channelId, rootId, onClose }: ThreadPanelProps) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const { sb, listen, fail } = ws;
  const { canManageMembers } = useAuth();
  const channel = ws.channels?.find((c) => c.id === channelId) ?? null;
  const block = useWriteBlock(channel);
  const [root, setRoot] = useState<TimelineState>(() =>
    createTimeline(channelId)
  );
  const [replies, setReplies] = useState<TimelineState>(() =>
    createTimeline(channelId, rootId)
  );
  const [card, setCard] = useState<SharedCard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let off = false;
    (async () => {
      const [head, page] = await Promise.all([
        sb
          .from('internal_messages')
          .select(MESSAGE_COLUMNS)
          .eq('id', rootId)
          .maybeSingle(),
        listMessages(sb, channelId, {
          threadRootId: rootId,
          limit: REPLY_LIMIT,
        }),
      ]);
      if (head.error) throw toChatError(head.error);
      const rootRow = head.data
        ? toChatMessage(head.data as Record<string, unknown>)
        : null;
      const all = rootRow ? [rootRow, ...page.messages] : page.messages;
      const ids = all.map((m) => m.id);
      const rootIds = rootRow ? [rootRow.id] : [];
      const [attachments, reactions, threads, cards] = await Promise.all([
        attachmentsFor(sb, ids),
        reactionsFor(sb, ids),
        threadSummaries(sb, rootIds),
        sharedCards(sb, rootIds),
      ]);
      if (off) return;
      const detailed = withDetails(all, { attachments, reactions, threads });
      setRoot({
        ...createTimeline(channelId),
        messages: rootRow ? detailed.slice(0, 1) : [],
        hasMoreOlder: false,
      });
      setReplies({
        ...createTimeline(channelId, rootId),
        messages: rootRow ? detailed.slice(1) : detailed,
        hasMoreOlder: page.hasMore,
      });
      setCard(cards[0] ?? null);
    })()
      .catch((err) => !off && fail(err))
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
  }, [sb, channelId, rootId, fail]);

  useEffect(
    () =>
      listen((e) => {
        if (e.kind === 'reaction') {
          setRoot((s) => applyReactionEvent(s, e.event));
          setReplies((s) => applyReactionEvent(s, e.event));
          return;
        }
        if (e.kind !== 'message') return;
        const ev = e.event;
        if (
          ev.type === 'delete' ||
          ev.message.id === rootId ||
          ev.message.threadRootId === rootId
        )
          setRoot((s) => applyMessageEvent(s, ev));
        setReplies((s) => applyMessageEvent(s, ev));
        // The row event carries no attachments: read a new reply's.
        if (ev.type === 'insert' && ev.message.threadRootId === rootId) {
          const m = ev.message;
          attachmentsFor(sb, [m.id])
            .then((a) =>
              setReplies((s) =>
                applyMessageEvent(s, {
                  type: 'update',
                  message: { ...m, attachments: a[m.id] ?? [] },
                })
              )
            )
            .catch(() => {});
        }
      }),
    [listen, sb, rootId]
  );

  /** Not optimistic: the realtime echo applies the change. */
  const toggle = useCallback(
    (messageId: string, emoji: string) => {
      toggleReaction(sb, messageId, emoji).catch(fail);
    },
    [sb, fail]
  );

  const rootMsg = root.messages.find((m) => m.id === rootId) ?? null;
  const label = channel
    ? `${channel.kind === 'dm' ? '' : '#'}${channelDisplayName(
        channel,
        ws.userId ?? '',
        ws.peopleById,
        t('unknownPerson')
      )}`
    : '';
  const sub = [label, card?.snapshot.contactName].filter(Boolean).join(' · ');
  const actions: RowActionContext = {
    userId: ws.userId,
    workspaceAdmin: canManageMembers,
    canWrite: block === null,
    threads: false,
    broadcasts: channel ? offersBroadcasts(channel.kind) : false,
  };

  return (
    <aside
      aria-label={t('thread.title')}
      className="bg-background fixed inset-0 z-40 flex min-h-0 flex-col lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold">{t('thread.title')}</h3>
          {sub && (
            <p className="text-muted-foreground truncate text-xs">{sub}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('thread.close')}
          className="hover:bg-muted -mr-1 rounded p-1"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3">
        {loading ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            {t('thread.loading')}
          </p>
        ) : rootMsg ? (
          <>
            <MessageRow
              message={rootMsg}
              grouped={false}
              card={card ?? undefined}
              actions={actions}
              onToggleReaction={toggle}
            />
            <div className="flex items-center gap-3 px-4 pt-3 pb-1">
              <span className="text-muted-foreground text-xs font-medium">
                {t('thread.replies', {
                  count: rootMsg.thread?.replyCount ?? 0,
                })}
              </span>
              <span className="bg-border h-px flex-1" />
            </div>
            {replies.messages.map((m, i) => (
              <MessageRow
                key={m.id}
                message={m}
                grouped={isGroupedWithPrevious(replies.messages[i - 1], m)}
                actions={actions}
                onToggleReaction={toggle}
              />
            ))}
          </>
        ) : (
          <p className="text-muted-foreground p-6 text-center text-sm">
            {t('thread.gone')}
          </p>
        )}
      </div>
      {rootMsg && !rootMsg.deletedAt && (
        <Composer
          key={rootId}
          channelId={channelId}
          threadRootId={rootId}
          sharedCard={card}
        />
      )}
    </aside>
  );
}
