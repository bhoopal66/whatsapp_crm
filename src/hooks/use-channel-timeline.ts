'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  attachmentsFor,
  createTimeline,
  listMessages,
  reactionsFor,
  sharedCallCards,
  sharedCards,
  threadSummaries,
  toggleReaction,
  type SharedCallCard,
  type SharedCard,
} from '@/lib/chat';
import {
  applyOlderPage,
  applyTimelineDetails,
  beginTimelineFetch,
  endTimelineFetch,
  placeholderTimeline,
  recordTimelineEvent,
  revalidateTimeline,
  shouldPrefetchTimeline,
  timelineCacheKey,
  timelineEventTargets,
  timelineMark,
  type CachedTimeline,
  type TimelineEvent,
} from '@/lib/chat/timeline-cache';
import {
  prefetchSession,
  sessionCache,
  type SessionKey,
} from '@/lib/session-cache';
import type { ChatWorkspace } from '@/hooks/use-chat-workspace';

const PAGE_SIZE = 50;

/**
 * Fetch a channel's newest page (rows only) into its cache entry. The
 * fetch is opened on the entry (a placeholder when there is none, so
 * realtime events land in it meanwhile) and the page is merged into the
 * entry as it is when the page lands, with the events recorded during
 * the flight replayed over it. Shared by the sidebar's hover prefetch
 * and the timeline itself (prefetchSession joins a fetch already in
 * flight, so a hover is not repeated).
 */
export function fetchTimelineFirstPage(
  sb: SupabaseClient,
  key: SessionKey,
  channelId: string,
  opts: { keepOlder?: boolean } = {}
): Promise<CachedTimeline> {
  return prefetchSession(key, async () => {
    const mark = timelineMark();
    const open = (e: CachedTimeline) => beginTimelineFetch(e, mark);
    if (!sessionCache.update<CachedTimeline>(key, open))
      sessionCache.set(key, open(placeholderTimeline(channelId)));
    let page;
    try {
      page = await listMessages(sb, channelId, { limit: PAGE_SIZE });
    } catch (err) {
      sessionCache.update<CachedTimeline>(key, (e) =>
        endTimelineFetch(e, mark)
      );
      throw err;
    }
    const prev = sessionCache.peek<CachedTimeline>(key)?.value;
    // Dropped meanwhile (the channel left the list, the cache was
    // evicted): the page is not merged, but prefetchSession still stores
    // what this returns (delete() does not cancel a fetch in flight), so
    // an empty, not-loaded placeholder entry comes back. Harmless: it
    // shows the skeleton and the next show revalidates.
    if (!prev) return placeholderTimeline(channelId);
    return revalidateTimeline(prev, channelId, page, Date.now(), mark, opts);
  });
}

/** The sidebar's hover: fetch unless the entry was fetched moments ago. */
export function prefetchChannelTimeline(
  sb: SupabaseClient,
  accountId: string | null | undefined,
  userId: string | null | undefined,
  channelId: string
): void {
  const key = timelineCacheKey(accountId, userId, channelId);
  if (!key) return;
  const entry = sessionCache.peek<CachedTimeline>(key)?.value;
  if (!shouldPrefetchTimeline(entry, Date.now())) return;
  fetchTimelineFirstPage(sb, key, channelId).catch(() => {});
}

async function fetchDetails(sb: SupabaseClient, ids: string[]) {
  const [attachments, reactions, threads, cards, callCards] = await Promise.all(
    [
      attachmentsFor(sb, ids),
      reactionsFor(sb, ids),
      threadSummaries(sb, ids),
      sharedCards(sb, ids),
      sharedCallCards(sb, ids),
    ]
  );
  return { attachments, reactions, threads, cards, callCards };
}

const noopUnsubscribe = () => {};
const NO_CARDS: Record<string, SharedCard> = {};
const NO_CALL_CARDS: Record<string, SharedCallCard> = {};

/**
 * One channel's top-level timeline: pages from listMessages with their
 * details (attachments, reactions, thread summaries, shared cards) and
 * the workspace's realtime events applied through the pure reducers.
 *
 * The timeline lives in the session cache (`lib/chat/timeline-cache.ts`)
 * and every change is written there: a channel opened before shows at
 * once and is always revalidated, and the messages show as soon as the
 * rows land, their details merged in when they arrive.
 */
export function useChannelTimeline(ws: ChatWorkspace, channelId: string) {
  const { sb, listen, fail, userId, accountId } = ws;
  const key = timelineCacheKey(accountId, userId, channelId);
  // Read by the realtime handler, which should not resubscribe each
  // time the channel list refreshes.
  const channelsRef = useRef(ws.channels);
  useEffect(() => {
    channelsRef.current = ws.channels;
  });
  const subscribe = useCallback(
    (onChange: () => void) =>
      key ? sessionCache.subscribe(key, onChange) : noopUnsubscribe,
    [key]
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? sessionCache.peek<CachedTimeline>(key)?.value : undefined),
    () => undefined
  );
  // Which key's first fetch failed, so the skeleton does not stay up.
  const [failedKey, setFailedKey] = useState<SessionKey | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const patch = useCallback(
    (fn: (e: CachedTimeline) => CachedTimeline) => {
      if (key) sessionCache.update<CachedTimeline>(key, fn);
    },
    [key]
  );

  /** Apply a realtime event or a toggle, journaled for open fetches. */
  const record = useCallback(
    (event: TimelineEvent) => patch((s) => recordTimelineEvent(s, event)),
    [patch]
  );

  const loadDetails = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const mark = timelineMark();
      patch((e) => beginTimelineFetch(e, mark));
      try {
        const details = await fetchDetails(sb, ids);
        patch((e) => applyTimelineDetails(e, ids, details, mark));
      } catch (err) {
        patch((e) => endTimelineFetch(e, mark));
        throw err;
      }
    },
    [sb, patch]
  );

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    // Cached or not, always revalidate: rows first, details after.
    fetchTimelineFirstPage(sb, key, channelId)
      .then((fresh) => loadDetails(fresh.timeline.messages.map((m) => m.id)))
      .catch((err) => {
        if (cancelled) return;
        setFailedKey(key);
        fail(err);
      });
    return () => {
      cancelled = true;
    };
  }, [key, sb, channelId, loadDetails, fail, attempt]);

  const retry = useCallback(() => {
    setFailedKey(null);
    setAttempt((n) => n + 1);
  }, []);

  const loadOlder = useCallback(async () => {
    const s = key ? sessionCache.peek<CachedTimeline>(key)?.value : undefined;
    const oldest = s?.timeline.messages[0];
    if (!s || !oldest || loadingOlder || !s.timeline.hasMoreOlder) return;
    setLoadingOlder(true);
    const mark = timelineMark();
    patch((e) => beginTimelineFetch(e, mark));
    try {
      let page;
      try {
        page = await listMessages(sb, channelId, {
          limit: PAGE_SIZE,
          before: { createdAt: oldest.createdAt, id: oldest.id },
        });
      } catch (err) {
        patch((e) => endTimelineFetch(e, mark));
        throw err;
      }
      patch((e) => applyOlderPage(e, page, mark));
      await loadDetails(page.messages.map((m) => m.id));
    } catch (err) {
      fail(err);
    } finally {
      setLoadingOlder(false);
    }
  }, [key, sb, channelId, loadingOlder, patch, loadDetails, fail]);

  useEffect(
    () =>
      listen((e) => {
        if (e.kind === 'reaction') {
          record({ kind: 'reaction', event: e.event });
          return;
        }
        if (e.kind === 'resync') {
          // Events were missed: the newest page again, without dropping
          // the older pages someone may be reading. A failure is silent
          // and what is on screen stays; the catch-up tries again.
          if (!key) return;
          return fetchTimelineFirstPage(sb, key, channelId, {
            keepOlder: true,
          }).then((fresh) => {
            loadDetails(
              fresh.timeline.messages.slice(-PAGE_SIZE).map((m) => m.id)
            ).catch(() => {});
          });
        }
        if (e.kind !== 'message') return;
        const ev = e.event;
        const targets = timelineEventTargets(
          ev,
          channelId,
          (channelsRef.current ?? []).map((c) => c.id)
        );
        if (targets.open) record({ kind: 'message', event: ev });
        // Keep a channel opened earlier current for its revisit (a no-op
        // when it has no entry), and journal a delete for a prefetch of
        // it in flight (timelineEventTargets); its revalidation brings
        // the reactions and details this event cannot.
        for (const id of targets.others) {
          const other = timelineCacheKey(accountId, userId, id);
          if (other)
            sessionCache.update<CachedTimeline>(other, (s) =>
              recordTimelineEvent(s, { kind: 'message', event: ev })
            );
        }
        if (ev.type === 'delete' || !targets.open) return;
        // A new top-level post: fetch what the row event does not carry.
        if (ev.type === 'insert' && !ev.message.threadRootId) {
          loadDetails([ev.message.id]).catch(() => {});
        }
      }),
    [listen, sb, key, channelId, accountId, userId, record, loadDetails]
  );

  /** Optimistic; the realtime echo is a no-op in the reducer. */
  const toggle = useCallback(
    async (messageId: string, emoji: string) => {
      if (!userId || !key) return;
      const msg = sessionCache
        .peek<CachedTimeline>(key)
        ?.value.timeline.messages.find((m) => m.id === messageId);
      const mine = msg?.reactions
        .find((r) => r.emoji === emoji)
        ?.userIds.includes(userId);
      const event = { messageId, userId, emoji };
      const apply = (type: 'add' | 'remove') =>
        record({ kind: 'reaction', event: { ...event, type } });
      apply(mine ? 'remove' : 'add');
      try {
        await toggleReaction(sb, messageId, emoji);
      } catch (err) {
        apply(mine ? 'add' : 'remove');
        fail(err);
      }
    },
    [sb, userId, key, record, fail]
  );

  const shown =
    entry && entry.timeline.channelId === channelId ? entry : undefined;
  const empty = useMemo(() => createTimeline(channelId), [channelId]);
  const timeline = shown?.loaded ? shown.timeline : empty;
  return {
    ...timeline,
    cards: shown?.cards ?? NO_CARDS,
    callCards: shown?.callCards ?? NO_CALL_CARDS,
    // Until there are rows to show: a failed read is no empty channel,
    // and must not count as one seen (the read mark, the divider).
    loading: !shown?.loaded,
    failed: !shown?.loaded && key !== null && failedKey === key,
    retry,
    loadingOlder,
    loadOlder,
    toggle,
  };
}
