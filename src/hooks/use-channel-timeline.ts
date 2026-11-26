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
  beginTimelineFetch,
  endTimelineFetch,
  missingFiles,
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
  createDetailLoader,
  type ReadDetail,
} from '@/lib/chat/timeline-details';
import {
  prefetchSession,
  sessionCache,
  type SessionKey,
} from '@/lib/session-cache';
import type { ChatWorkspace } from '@/hooks/use-chat-workspace';

const PAGE_SIZE = 50;

/** The mark each newest page now being read began at. */
const pageReads = new Map<SessionKey, number>();

/**
 * Realtime was down, or nobody listened: a page read begun before now is
 * not whole, whenever it lands, so nothing joins it any more.
 */
export function timelineGap(): void {
  pageReads.clear();
}

/**
 * Fetch a channel's newest page (rows only) into its cache entry. The
 * fetch is opened on the entry (a placeholder when there is none, so
 * realtime events land in it meanwhile) and the page is merged into the
 * entry as it is when the page lands, with the events recorded during
 * the flight replayed over it. Shared by the sidebar's hover prefetch
 * and the timeline itself, which joins one in flight (a hover is not
 * repeated) unless it began before a gap or `force` asks for one begun
 * now. Never joining is how a catch-up is sure to cover its gap.
 */
export function fetchTimelineFirstPage(
  sb: SupabaseClient,
  key: SessionKey,
  channelId: string,
  { force, ...opts }: { keepOlder?: boolean; force?: boolean } = {}
): Promise<CachedTimeline> {
  const read = async () => {
    const mark = timelineMark();
    pageReads.set(key, mark);
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
    } finally {
      if (pageReads.get(key) === mark) pageReads.delete(key);
    }
    const prev = sessionCache.peek<CachedTimeline>(key)?.value;
    // Dropped meanwhile (the channel left the list, the cache was
    // evicted): the page is not merged, but prefetchSession still stores
    // what this returns (delete() does not cancel a fetch in flight), so
    // an empty, not-loaded placeholder entry comes back. Harmless: it
    // shows the skeleton and the next show revalidates.
    if (!prev) return placeholderTimeline(channelId);
    // A later read of it has landed already: this answer is the older one.
    const next =
      (prev.pageMark ?? 0) > mark
        ? endTimelineFetch(prev, mark)
        : revalidateTimeline(prev, channelId, page, Date.now(), mark, opts);
    // Written here too: of two reads prefetchSession stores the later one
    // only, and the first page to land is shown (and its flight closed).
    sessionCache.update(key, () => next);
    return next;
  };
  return prefetchSession(key, read, { force: force || !pageReads.has(key) });
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

const DETAIL_READS = {
  attachments: attachmentsFor,
  reactions: reactionsFor,
  threads: threadSummaries,
  cards: sharedCards,
  callCards: sharedCallCards,
};

const noopUnsubscribe = () => {};
const NO_CARDS: Record<string, SharedCard> = {};
const NO_CALL_CARDS: Record<string, SharedCallCard> = {};
const NO_IDS: ReadonlySet<string> = new Set();

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

  // A details read that fails never fails the page it belongs to.
  const details = useMemo(
    () =>
      createDetailLoader({
        read: ((kind, ids) => DETAIL_READS[kind](sb, ids)) as ReadDetail,
        get: () =>
          key ? sessionCache.peek<CachedTimeline>(key)?.value : undefined,
        patch,
      }),
    [sb, key, patch]
  );
  useEffect(() => details.show(), [details]);

  // The mark of this visit, or of the last gap in realtime: until a page
  // read since has landed, rows may be missing before the newest one shown
  // (a cached timeline, a live row that came before the gap was filled).
  const staleSince = useRef(Number.POSITIVE_INFINITY);
  /** Whether one has. Asked when it matters. */
  const isFresh = useCallback(() => {
    const mark = key && sessionCache.peek<CachedTimeline>(key)?.value.pageMark;
    return typeof mark === 'number' && mark >= staleSince.current;
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    // A hover's read still under way is joined, and counts.
    staleSince.current = pageReads.get(key) ?? timelineMark();
    // Cached or not, always revalidate: rows first, details after.
    fetchTimelineFirstPage(sb, key, channelId)
      .then((fresh) => details.load(fresh.timeline.messages.map((m) => m.id)))
      .catch((err) => {
        if (cancelled) return;
        setFailedKey(key);
        fail(err);
      });
    return () => {
      cancelled = true;
      staleSince.current = Number.POSITIVE_INFINITY;
    };
  }, [key, sb, channelId, details, fail, attempt]);

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
      await details.load(page.messages.map((m) => m.id));
    } catch (err) {
      fail(err);
    } finally {
      setLoadingOlder(false);
    }
  }, [key, sb, channelId, loadingOlder, patch, details, fail]);

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
          staleSince.current = timelineMark();
          return fetchTimelineFirstPage(sb, key, channelId, {
            keepOlder: true,
            force: true,
          }).then((fresh) => {
            void details.catchUp(
              fresh.timeline.messages.slice(-PAGE_SIZE).map((m) => m.id)
            );
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
          void details.load([ev.message.id]);
        }
      }),
    [listen, sb, key, channelId, accountId, userId, record, details]
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
  const missing = useMemo(
    () => (shown ? missingFiles(shown) : NO_IDS),
    [shown]
  );
  return {
    ...timeline,
    missingFiles: missing,
    retryFiles: details.retry,
    cards: shown?.cards ?? NO_CARDS,
    callCards: shown?.callCards ?? NO_CALL_CARDS,
    // Until there are rows to show: a failed read is no empty channel,
    // and must not count as one seen (the read mark, the divider). A
    // cached timeline shows at once; the read mark also asks isFresh.
    loading: !shown?.loaded,
    failed: !shown?.loaded && key !== null && failedKey === key,
    isFresh,
    pageMark: shown?.pageMark ?? null,
    retry,
    loadingOlder,
    loadOlder,
    toggle,
  };
}
