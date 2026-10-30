'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useChannelMembers } from '@/hooks/use-channel-members';
import { isChannelModerator } from '@/lib/chat/moderation';
import {
  applyMessageEvent,
  applyReactionEvent,
  attachmentsFor,
  createTimeline,
  isGroupedWithPrevious,
  listMessages,
  MESSAGE_COLUMNS,
  reactionsFor,
  sharedCallCards,
  sharedCards,
  threadSummaries,
  toChatError,
  toChatMessage,
  toggleReaction,
  withDetails,
  type SharedCallCard,
  type SharedCard,
  type TimelineState,
} from '@/lib/chat';
import { offersBroadcasts } from '@/lib/chat/composer-input';
import { channelDisplayName } from '@/lib/chat/view';

import { useChatWorkspaceContext } from './chat-context';
import { Composer } from './composer';
import type { RowActionContext } from './message-actions';
import { MessageRow } from './message-row';
import { useVoicePlaysValue, VoicePlaysProvider } from './played-by';
import { QuoteProvider, useQuoteResolver } from './quotes';
import { ReplyTargetProvider } from './reply-target';
import { TypingIndicator } from './typing-indicator';
import { useWriteBlock } from './use-write-block';

/** Replies read at once; a longer thread shows its latest ones. */
const REPLY_LIMIT = 200;
/** How long a quote's jump target stays tinted (as in the main timeline). */
const HIGHLIGHT_MS = 2000;

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
  const { canManageMembers, isBankGuest } = useAuth();
  const channel = ws.channels?.find((c) => c.id === channelId) ?? null;
  const block = useWriteBlock(channel);
  const [root, setRoot] = useState<TimelineState>(() =>
    createTimeline(channelId)
  );
  const [replies, setReplies] = useState<TimelineState>(() =>
    createTimeline(channelId, rootId)
  );
  const [card, setCard] = useState<SharedCard | null>(null);
  const [callCard, setCallCard] = useState<SharedCallCard | null>(null);
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
      const [attachments, reactions, threads, cards, calls] = await Promise.all(
        [
          attachmentsFor(sb, ids),
          reactionsFor(sb, ids),
          threadSummaries(sb, rootIds),
          sharedCards(sb, rootIds),
          sharedCallCards(sb, rootIds),
        ]
      );
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
      setCallCard(calls[0] ?? null);
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

  // A quote in the thread names the root or another reply (156), so its
  // jump stays inside this panel; one not shown here does nothing.
  const scrollerRef = useRef<HTMLDivElement>(null);
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
        t('unknownPerson')
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
      <ReplyTargetProvider scope={`${channelId}:${rootId}`}>
        <QuoteProvider value={quoteLookup}>
          {/* useNearViewport's root: voice notes load a screen ahead. */}
          <VoicePlaysProvider value={voicePlays}>
            <div
              ref={scrollerRef}
              data-inbox-scroll-root=""
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3"
            >
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
          {rootMsg && !rootMsg.deletedAt && (
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
