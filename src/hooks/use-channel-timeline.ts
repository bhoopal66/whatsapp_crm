'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyMessageEvent,
  applyReactionEvent,
  attachmentsFor,
  createTimeline,
  listMessages,
  mergePage,
  reactionsFor,
  sharedCards,
  threadSummaries,
  toggleReaction,
  withDetails,
  type ChatMessage,
  type SharedCard,
  type TimelineState,
} from '@/lib/chat';
import type { ChatWorkspace } from '@/hooks/use-chat-workspace';

const PAGE_SIZE = 50;

/**
 * One channel's top-level timeline: pages from listMessages with their
 * details (attachments, reactions, thread summaries, shared cards) and
 * the workspace's realtime events applied through the pure reducers.
 */
export function useChannelTimeline(ws: ChatWorkspace, channelId: string) {
  const { sb, listen, fail, userId } = ws;
  const [state, setState] = useState<TimelineState>(() =>
    createTimeline(channelId)
  );
  const [cards, setCards] = useState<Record<string, SharedCard>>({});
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const withAllDetails = useCallback(
    async (messages: ChatMessage[]) => {
      const ids = messages.map((m) => m.id);
      const [attachments, reactions, threads, shared] = await Promise.all([
        attachmentsFor(sb, ids),
        reactionsFor(sb, ids),
        threadSummaries(sb, ids),
        sharedCards(sb, ids),
      ]);
      setCards((prev) => {
        const next = { ...prev };
        for (const c of shared) next[c.messageId] = c;
        return next;
      });
      return withDetails(messages, { attachments, reactions, threads });
    },
    [sb]
  );

  const loadPage = useCallback(
    async (before?: ChatMessage) => {
      const page = await listMessages(sb, channelId, {
        limit: PAGE_SIZE,
        before: before
          ? { createdAt: before.createdAt, id: before.id }
          : undefined,
      });
      const messages = await withAllDetails(page.messages);
      setState((s) =>
        s.channelId === channelId ? mergePage(s, { ...page, messages }) : s
      );
    },
    [sb, channelId, withAllDetails]
  );

  useEffect(() => {
    let cancelled = false;
    loadPage()
      .catch((err) => !cancelled && fail(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [channelId, loadPage, fail]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (loadingOlder || !s.hasMoreOlder || s.messages.length === 0) return;
    setLoadingOlder(true);
    try {
      await loadPage(s.messages[0]);
    } catch (err) {
      fail(err);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, loadPage, fail]);

  useEffect(
    () =>
      listen((e) => {
        if (e.kind === 'reaction') {
          setState((s) => applyReactionEvent(s, e.event));
          return;
        }
        if (e.kind !== 'message') return;
        const ev = e.event;
        setState((s) => applyMessageEvent(s, ev));
        // A new top-level post: fetch what the row event does not carry.
        if (
          ev.type === 'insert' &&
          ev.message.channelId === channelId &&
          !ev.message.threadRootId
        ) {
          withAllDetails([ev.message])
            .then(([m]) =>
              setState((s) =>
                applyMessageEvent(s, { type: 'update', message: m })
              )
            )
            .catch(() => {});
        }
      }),
    [listen, channelId, withAllDetails]
  );

  /** Optimistic; the realtime echo is a no-op in the reducer. */
  const toggle = useCallback(
    async (messageId: string, emoji: string) => {
      if (!userId) return;
      const msg = stateRef.current.messages.find((m) => m.id === messageId);
      const mine = msg?.reactions
        .find((r) => r.emoji === emoji)
        ?.userIds.includes(userId);
      const event = { messageId, userId, emoji };
      setState((s) =>
        applyReactionEvent(s, { ...event, type: mine ? 'remove' : 'add' })
      );
      try {
        await toggleReaction(sb, messageId, emoji);
      } catch (err) {
        setState((s) =>
          applyReactionEvent(s, { ...event, type: mine ? 'add' : 'remove' })
        );
        fail(err);
      }
    },
    [sb, userId, fail]
  );

  return { ...state, cards, loading, loadingOlder, loadOlder, toggle };
}
