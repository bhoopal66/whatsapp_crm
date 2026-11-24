import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Team chat after a gap in realtime. No DOM here: React's hooks are stood
// in for, as in live-read-wiring.test.tsx; an effect runs at once.
const cleanups: (() => void)[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [
    typeof init === 'function' ? init() : init,
    (next: unknown) => void setStates.push(next),
  ],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc', user: { id: 'u1' } }),
}));
vi.mock('@/hooks/use-phone-presence', () => ({
  usePhonePresence: () => null,
}));
vi.mock('@/hooks/use-ai-auto-reply-live', () => ({
  useAiAutoReplyLive: () => false,
}));
vi.mock('@/hooks/use-chat-tags', () => ({ useChatTags: () => ({}) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const refreshed: string[] = [];
// The questions whose next re-read fails, once each.
const failing = new Set<string>();
let channels: { data?: unknown[]; error: unknown } = { error: null };
// What the state setters were called with: no state is kept here.
const setStates: unknown[] = [];
const fetchers = new Map<string, () => Promise<unknown>>();
// One array, drawn at once and answered again by each read of the counts.
const counts = [{ channelId: 'c', unread: 0, mentions: 0 }];
vi.mock('@/hooks/use-session-query', () => ({
  useSessionQuery: (key: string, fetcher: () => Promise<unknown>) => ({
    ...(fetchers.set(key, fetcher) && { data: undefined }),
    ...channels,
    ...(key.endsWith('chat:unread') && { data: counts }),
    refresh: async () => {},
    reread: async () => {
      const question = key.split(':').slice(3).join(':');
      refreshed.push(question);
      if (failing.delete(question)) throw new Error('503');
    },
  }),
}));

let status: ((s: string) => void) | undefined;
let onMessage: ((e: unknown) => void) | undefined;
const listMessages = vi.fn(
  async (): Promise<{ messages: unknown[]; hasMore: boolean }> => ({
    messages: [],
    hasMore: false,
  })
);
const attachmentsFor = vi.fn(async () => ({}));
vi.mock('@/lib/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat')>()),
  subscribeChat: (
    _sb: unknown,
    opts: { onStatus?: typeof status; onMessage?: typeof onMessage }
  ) => {
    status = opts.onStatus;
    onMessage = opts.onMessage;
    return () => {};
  },
  listMessages: (...args: unknown[]) => listMessages(...(args as [])),
  attachmentsFor: () => attachmentsFor(),
  unreadCounts: async () => counts,
}));

import {
  CHAT_CHANNELS_QUESTION,
  CHAT_UNREAD_QUESTION,
} from '@/lib/chat/channel-list-cache';
import { CATCH_UP_GAP_MS, RETRY_DELAYS_MS } from '@/lib/realtime/catch-up';
import {
  timelineCacheKey,
  type CachedTimeline,
} from '@/lib/chat/timeline-cache';
import { sessionCache } from '@/lib/session-cache';
import {
  fetchTimelineFirstPage,
  useChannelTimeline,
} from './use-channel-timeline';
import { useChatWorkspace, type ChatEvent } from './use-chat-workspace';

const CHANNEL = 'c0000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.useFakeTimers();
  sessionCache.clear();
  refreshed.length = 0;
  failing.clear();
  listMessages.mockClear();
  channels = { error: null };
  setStates.length = 0;
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});

describe('team chat after a gap', () => {
  it('reads the channels and unread counts again and tells its listeners', async () => {
    const ws = useChatWorkspace();
    const heard: ChatEvent['kind'][] = [];
    ws.listen((e) => heard.push(e.kind));
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(10_000);
    expect([heard, refreshed]).toEqual([[], []]);

    status?.('CHANNEL_ERROR');
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heard).toEqual(['resync']);
    expect(refreshed).toHaveLength(2);
  });

  it.each([CHAT_CHANNELS_QUESTION, CHAT_UNREAD_QUESTION])(
    'tries the whole catch-up again when %s was not read',
    async (question) => {
      const ws = useChatWorkspace();
      const heard: ChatEvent['kind'][] = [];
      ws.listen((e) => heard.push(e.kind));
      failing.add(question);
      status?.('CLOSED');
      status?.('SUBSCRIBED');
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshed).toHaveLength(0);
      // The catch-up's own gap since the workspace opened, then one retry.
      await vi.advanceTimersByTimeAsync(CATCH_UP_GAP_MS);
      expect(refreshed).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
      expect(refreshed.filter((q) => q === question)).toHaveLength(2);
      expect(heard).toEqual(['resync', 'resync']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshed).toHaveLength(4);
    }
  );

  it('tries again when a listener could not read', async () => {
    const ws = useChatWorkspace();
    const answers = [Promise.reject(new Error('503')), Promise.resolve()];
    answers[0].catch(() => {});
    const resync = vi.fn(() => answers.shift());
    ws.listen(resync);
    status?.('CLOSED');
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resync).toHaveBeenCalledTimes(2);
  });

  it('tries the open channel again when its page was not read', async () => {
    const ws = useChatWorkspace();
    useChannelTimeline(ws, CHANNEL);
    await vi.advanceTimersByTimeAsync(10_000);
    listMessages.mockRejectedValueOnce(new Error('503'));
    status?.('CLOSED');
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listMessages).toHaveBeenCalledTimes(3);
    // Silently: no failed state was set.
    expect(setStates).toEqual([]);
  });

  it('a channel may be marked read only once its page landed, again after a gap', async () => {
    const heard: ((e: ChatEvent) => unknown)[] = [];
    const listen = (fn: (e: ChatEvent) => unknown) => {
      heard.push(fn);
      return () => {};
    };
    const ws = { ...useChatWorkspace(), listen, fail: () => '' };
    // Opened before: its timeline is held, and shown at once.
    useChannelTimeline(ws, CHANNEL);
    await vi.advanceTimersByTimeAsync(10);
    cleanups.splice(0).forEach((fn) => fn());
    await vi.advanceTimersByTimeAsync(10);
    heard.length = 0;

    const tl = useChannelTimeline(ws, CHANNEL);
    expect([tl.loading, tl.isFresh()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(10);
    expect(tl.isFresh()).toBe(true);

    listMessages.mockRejectedValueOnce(new Error('503'));
    const missed = heard[0]({ kind: 'resync' }) as Promise<void>;
    missed.catch(() => {});
    expect(tl.isFresh()).toBe(false);
    await expect(missed).rejects.toThrow('503');
    expect(tl.isFresh()).toBe(false);
    void heard[0]({ kind: 'resync' });
    await vi.advanceTimersByTimeAsync(10);
    expect(tl.isFresh()).toBe(true);

    cleanups.splice(0).forEach((fn) => fn());
    expect(tl.isFresh()).toBe(false);
  });

  describe('a page read begun before the gap', () => {
    const row = (id: string, minute: number) => ({
      id,
      channelId: CHANNEL,
      threadRootId: null,
      createdAt: `2026-11-24T08:0${minute}:00+00:00`,
      deletedAt: null,
      attachments: [],
      reactions: [],
    });
    const held = () =>
      sessionCache
        .peek<CachedTimeline>(timelineCacheKey('acc', 'u1', CHANNEL)!)
        ?.value.timeline.messages.map((m) => m.id);
    /** Page reads that answer when told to. */
    function slowPages() {
      const answers: ((ids: ReturnType<typeof row>[]) => void)[] = [];
      for (let i = 0; i < 2; i++)
        listMessages.mockImplementationOnce(
          () =>
            new Promise((ok) =>
              answers.push((messages) => ok({ messages, hasMore: false }))
            )
        );
      return answers;
    }
    function useOpenChannel() {
      const heard: ((e: ChatEvent) => unknown)[] = [];
      const listen = (fn: (e: ChatEvent) => unknown) => {
        heard.push(fn);
        return () => {};
      };
      const ws = { ...useChatWorkspace(), listen, fail: () => '' };
      const tl = useChannelTimeline(ws, CHANNEL);
      return { tl, resync: () => void heard[0]({ kind: 'resync' }) };
    }

    it('is not joined by the catch-up, and does not count for it', async () => {
      const answers = slowPages();
      const { tl, resync } = useOpenChannel();
      resync();
      expect(listMessages).toHaveBeenCalledTimes(2);
      answers[0]([row('m1', 1)]);
      await vi.advanceTimersByTimeAsync(10);
      // Shown meanwhile, not marked read: m2 was sent in the gap.
      expect([held(), tl.isFresh()]).toEqual([['m1'], false]);
      answers[1]([row('m1', 1), row('m2', 2)]);
      await vi.advanceTimersByTimeAsync(10);
      expect([held(), tl.isFresh()]).toEqual([['m1', 'm2'], true]);
    });

    it('does not undo the catch-up when it lands after it', async () => {
      const answers = slowPages();
      const { tl, resync } = useOpenChannel();
      resync();
      answers[1]([row('m1', 1), row('m2', 2)]);
      await vi.advanceTimersByTimeAsync(10);
      answers[0]([row('m1', 1)]);
      await vi.advanceTimersByTimeAsync(10);
      expect([held(), tl.isFresh()]).toEqual([['m1', 'm2'], true]);
      const key = timelineCacheKey('acc', 'u1', CHANNEL)!;
      expect(sessionCache.peek<CachedTimeline>(key)?.value.flights).toEqual([]);
    });

    it("a hover's read is joined and counts, unless a gap came since", async () => {
      const key = timelineCacheKey('acc', 'u1', CHANNEL)!;
      let answers = slowPages();
      void fetchTimelineFirstPage({} as never, key, CHANNEL);
      const hovered = useOpenChannel();
      expect(listMessages).toHaveBeenCalledTimes(1);
      answers[0]([row('m1', 1)]);
      await vi.advanceTimersByTimeAsync(10);
      expect(hovered.tl.isFresh()).toBe(true);

      cleanups.splice(0).forEach((fn) => fn());
      listMessages.mockReset();
      answers = slowPages();
      useChatWorkspace();
      void fetchTimelineFirstPage({} as never, key, CHANNEL);
      status?.('CLOSED');
      status?.('SUBSCRIBED');
      await vi.advanceTimersByTimeAsync(CATCH_UP_GAP_MS);
      const { tl } = useOpenChannel();
      expect(listMessages).toHaveBeenCalledTimes(2);
      answers[0]([row('m1', 1)]);
      await vi.advanceTimersByTimeAsync(10);
      expect(tl.isFresh()).toBe(false);
      answers[1]([row('m1', 1)]);
      await vi.advanceTimersByTimeAsync(10);
      expect(tl.isFresh()).toBe(true);
    });
  });

  it('reads the files of a new message again when they were not read', async () => {
    const heard: ((e: ChatEvent) => unknown)[] = [];
    const listen = (fn: (e: ChatEvent) => unknown) => {
      heard.push(fn);
      return () => {};
    };
    useChannelTimeline({ ...useChatWorkspace(), listen }, CHANNEL);
    await vi.advanceTimersByTimeAsync(0);
    attachmentsFor.mockRejectedValueOnce(new Error('503'));
    const message = {
      id: 'm1',
      channelId: CHANNEL,
      threadRootId: null,
      createdAt: '2026-11-24T08:00:00+00:00',
      deletedAt: null,
      attachments: [],
      reactions: [],
    } as never;
    heard[0]({ kind: 'message', event: { type: 'insert', message } });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentsFor).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attachmentsFor).toHaveBeenCalledTimes(2);
  });

  it('the unread counts are proof only when read since', async () => {
    const read = () => fetchers.get(`s:acc:u1:${CHAT_UNREAD_QUESTION}`)!();
    useChatWorkspace();
    await read();
    // Held from an earlier visit.
    const ws = useChatWorkspace();
    expect(ws.isUnreadFresh()).toBe(false);
    await read();
    expect(ws.isUnreadFresh()).toBe(true);
    // A message came: the counts may lack it.
    onMessage?.({ type: 'delete', id: 'm' });
    expect(ws.isUnreadFresh()).toBe(false);
    await read();
    expect(ws.isUnreadFresh()).toBe(true);
    status?.('CLOSED');
    const early = read();
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(CATCH_UP_GAP_MS);
    await early;
    expect(ws.isUnreadFresh()).toBe(false);
    await read();
    expect(ws.isUnreadFresh()).toBe(true);
  });

  it('stops with the screen', async () => {
    useChatWorkspace();
    status?.('SUBSCRIBED');
    cleanups.splice(0).forEach((fn) => fn());
    status?.('CHANNEL_ERROR');
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshed).toEqual([]);
  });

  it('the open channel reads its newest page again', async () => {
    const ws = useChatWorkspace();
    useChannelTimeline(ws, CHANNEL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listMessages).toHaveBeenCalledTimes(1);
    status?.('CLOSED');
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });
});

describe('a failed team chat read', () => {
  it('is not an empty channel list', () => {
    expect(useChatWorkspace().channelsFailed).toBe(false);
    channels = { error: new Error('503') };
    expect(useChatWorkspace().channelsFailed).toBe(true);
    // The list held stays on screen when only its refresh failed.
    channels = { data: [], error: new Error('503') };
    expect(useChatWorkspace().channelsFailed).toBe(false);
  });

  it('is remembered for the channel it was raised for, never as loaded', async () => {
    const ws = useChatWorkspace();
    listMessages.mockRejectedValueOnce(new Error('503'));
    const tl = useChannelTimeline({ ...ws, fail: () => '' }, CHANNEL);
    // An unread channel is never `loaded`, so it is not marked read.
    expect(tl.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStates).toHaveLength(1);
    const failedKey = setStates[0];
    expect(failedKey).toContain(CHANNEL);
    tl.retry();
    expect(setStates[1]).toBeNull();
    expect((setStates[2] as (n: number) => number)(0)).toBe(1);
  });
});
