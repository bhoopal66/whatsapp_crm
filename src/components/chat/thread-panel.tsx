'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useChannelMembers } from '@/hooks/use-channel-members';
import { useMarkRead } from '@/hooks/use-mark-read';
import { useThread } from '@/hooks/use-thread';
import { isChannelModerator } from '@/lib/chat/moderation';
import {
  newestSeen,
  noteSeenMentions,
  nothingElseUnread,
  unreadMentions,
  withSeenMentions,
} from '@/lib/chat/read-mark';
import { unreadSince } from '@/lib/chat/receipts';
import { missingFiles } from '@/lib/chat/timeline-cache';
import { isGroupedWithPrevious, toggleReaction } from '@/lib/chat';
import { offersBroadcasts } from '@/lib/chat/composer-input';
import {
  holdThread,
  isAtBottom,
  threadScrollBy,
  type RowBox,
  type ThreadScroll,
} from '@/lib/chat/thread-scroll';
import { channelDisplayName } from '@/lib/chat/view';

import { useChatWorkspaceContext } from './chat-context';
import { Composer } from './composer';
import { LoadFailed } from './load-failed';
import type { RowActionContext } from './message-actions';
import { MessageRow } from './message-row';
import { useVoicePlaysValue, VoicePlaysProvider } from './played-by';
import { QuoteProvider, useQuoteResolver } from './quotes';
import { ReplyTargetProvider } from './reply-target';
import { TypingIndicator } from './typing-indicator';
import { useWriteBlock } from './use-write-block';

/** How long a quote's jump target stays tinted (as in the main timeline). */
const HIGHLIGHT_MS = 2000;

/** The list's rows, measured from the top of its viewport. */
function rowBoxes(el: HTMLElement): RowBox[] {
  const { top } = el.getBoundingClientRect();
  return [...el.querySelectorAll<HTMLElement>('[data-message-id]')].map(
    (row) => {
      const box = row.getBoundingClientRect();
      return {
        id: row.dataset.messageId ?? '',
        top: box.top - top,
        bottom: box.bottom - top,
      };
    }
  );
}

export interface ThreadPanelProps {
  channelId: string;
  rootId: string;
  onClose: () => void;
}

/**
 * The right column (a full-screen sheet below lg): the root message,
 * its replies and the thread composer (`use-thread.ts`).
 */
export function ThreadPanel({ channelId, rootId, onClose }: ThreadPanelProps) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const { sb, fail } = ws;
  const { canManageMembers, isBankGuest } = useAuth();
  const channel = ws.channels?.find((c) => c.id === channelId) ?? null;
  const block = useWriteBlock(channel);
  const { store, view } = useThread(ws, channelId, rootId);
  const replies = view.replies.timeline;
  const lostFiles = missingFiles(view.replies);
  const card = view.root.cards[rootId] ?? null;
  const callCard = view.root.callCards[rootId] ?? null;

  /** Not optimistic: the realtime echo applies the change. */
  const toggle = useCallback(
    (messageId: string, emoji: string) => {
      toggleReaction(sb, messageId, emoji).catch(fail);
    },
    [sb, fail]
  );

  const rootMsg =
    view.root.timeline.messages.find((m) => m.id === rootId) ?? null;

  // A quote in the thread names the root or another reply (156), so its
  // jump stays inside this panel; one not shown here does nothing.
  const scrollerRef = useRef<HTMLDivElement>(null);
  // What the reader sees, measured as the thread is about to change (the
  // store tells before React draws) and put back once it has.
  const heldScroll = useRef<ThreadScroll | null>(null);
  useEffect(
    () =>
      store.subscribe(() => {
        const el = scrollerRef.current;
        heldScroll.current = el && holdThread(rowBoxes(el), rootId, el);
      }),
    [store, rootId]
  );
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const held = heldScroll.current;
    heldScroll.current = null;
    if (!el || !held) return;
    const rows = rowBoxes(el);
    const topOf = (id: string) => rows.find((r) => r.id === id)?.top ?? null;
    el.scrollTop += threadScrollBy(held, topOf, el);
  }, [view]);

  // The channel's read mark, moved on to the newest reply once it is in
  // view and nothing else in the channel is unread: a mention in a thread
  // counts until then. A thread opens at its root, so where it is scrolled
  // to is measured as the mark falls due.
  const { userId, unread, isUnreadFresh } = ws;
  const since = unreadSince(channel?.membership);
  const mentions = useMemo(
    () => unreadMentions(replies.messages, userId, since),
    [replies.messages, userId, since]
  );
  const seenKey = `${userId}:${channelId}`;
  const mayMark = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !isAtBottom(el) || !store.isFresh()) return false;
    noteSeenMentions(seenKey, mentions, since);
    const seen = withSeenMentions(seenKey, mentions, since);
    return isUnreadFresh() && nothingElseUnread(unread, channelId, seen);
  }, [store, seenKey, mentions, since, unread, isUnreadFresh, channelId]);
  const recheckRead = useMarkRead(ws, {
    channelId,
    membership: channel?.membership,
    at: newestSeen(
      replies.messages[replies.messages.length - 1]?.createdAt ?? null,
      withSeenMentions(seenKey, mentions, since)
    ),
    ready: view.phase === 'ready',
    mayMark,
    version: view.replies.pageMark,
  });

  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);
  const shown = useMemo(
    () => (rootMsg ? [rootMsg, ...replies.messages] : replies.messages),
    [rootMsg, replies.messages]
  );
  const getQuote = useQuoteResolver(channelId, shown);
  const members = useChannelMembers(ws, channelId);
  const voicePlays = useVoicePlaysValue(shown, channel?.kind ?? null, members);
  const quoteLookup = useMemo(
    () => ({
      get: getQuote,
      jump: (id: string) => {
        const row = scrollerRef.current?.querySelector(
          `[data-message-id="${CSS.escape(id)}"]`
        );
        if (!row) return;
        row.scrollIntoView({ block: 'center' });
        setHighlightId(id);
      },
    }),
    [getQuote]
  );
  const label = channel
    ? `${channel.kind === 'dm' ? '' : '#'}${channelDisplayName(
        channel,
        ws.userId ?? '',
        ws.peopleById,
        ws.unknownName
      )}`
    : '';
  const sub = [label, card?.snapshot.contactName].filter(Boolean).join(' · ');
  const actions: RowActionContext = {
    userId: ws.userId,
    workspaceAdmin: canManageMembers,
    channelAdmin:
      !!channel &&
      isChannelModerator({
        kind: channel.kind,
        role: channel.membership?.role,
        bankGuest: isBankGuest,
      }),
    canWrite: block === null,
    threads: false,
    broadcasts: channel ? offersBroadcasts(channel.kind) : false,
  };

  return (
    <aside
      aria-label={t('thread.title')}
      className="bg-background fixed inset-0 z-40 flex min-h-0 flex-col lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-s"
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
          className="hover:bg-muted -me-1 rounded p-1"
        >
          <X className="size-4" />
        </button>
      </header>
      <ReplyTargetProvider scope={`${channelId}:${rootId}`}>
        <QuoteProvider value={quoteLookup}>
          {/* useNearViewport's root: voice notes load a screen ahead. */}
          <VoicePlaysProvider value={voicePlays}>
            <div
              ref={scrollerRef}
              onScroll={(e) => {
                if (isAtBottom(e.currentTarget)) recheckRead();
              }}
              data-inbox-scroll-root=""
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3"
            >
              {view.phase === 'failed' ? (
                <LoadFailed
                  message={t('timeline.loadFailed')}
                  onRetry={store.retry}
                />
              ) : view.phase === 'loading' ? (
                <p className="text-muted-foreground p-6 text-center text-sm">
                  {t('thread.loading')}
                </p>
              ) : rootMsg ? (
                <>
                  <MessageRow
                    message={rootMsg}
                    grouped={false}
                    card={card ?? undefined}
                    callCard={callCard ?? undefined}
                    actions={actions}
                    onToggleReaction={toggle}
                    highlighted={rootMsg.id === highlightId}
                  />
                  <div className="flex items-center gap-3 px-4 pt-3 pb-1">
                    <span className="text-muted-foreground text-xs font-medium">
                      {t('thread.replies', {
                        count: rootMsg.thread?.replyCount ?? 0,
                      })}
                    </span>
                    <span className="bg-border h-px flex-1" />
                  </div>
                  {replies.hasMoreOlder && (
                    <div className="px-4 py-2 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={view.loadingOlder}
                        onClick={() => void store.loadOlder()}
                      >
                        {t(
                          view.loadingOlder
                            ? 'thread.loadingOlder'
                            : 'thread.loadOlder'
                        )}
                      </Button>
                    </div>
                  )}
                  {replies.messages.map((m, i) => (
                    <MessageRow
                      key={m.id}
                      message={m}
                      grouped={isGroupedWithPrevious(
                        replies.messages[i - 1],
                        m
                      )}
                      actions={actions}
                      onToggleReaction={toggle}
                      onRetryFiles={
                        lostFiles.has(m.id) ? store.retryFiles : undefined
                      }
                      highlighted={m.id === highlightId}
                    />
                  ))}
                </>
              ) : (
                <p className="text-muted-foreground p-6 text-center text-sm">
                  {t('thread.gone')}
                </p>
              )}
            </div>
          </VoicePlaysProvider>
          {view.phase === 'ready' && rootMsg && !rootMsg.deletedAt && (
            <>
              <TypingIndicator channelId={channelId} threadRootId={rootId} />
              <Composer
                key={rootId}
                channelId={channelId}
                threadRootId={rootId}
                sharedCard={card}
              />
            </>
          )}
        </QuoteProvider>
      </ReplyTargetProvider>
    </aside>
  );
}
