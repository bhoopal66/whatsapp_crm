import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Team chat after a gap in realtime. No DOM here: React's hooks are stood
// in for, as in live-read-wiring.test.tsx; an effect runs at once.
const cleanups: (() => void)[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [
    typeof init === 'function' ? init() : init,
    () => {},
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
vi.mock('@/hooks/use-session-query', () => ({
  useSessionQuery: (key: string) => ({
    data: undefined,
    error: null,
    refresh: async () => void refreshed.push(key.split(':').pop()!),
  }),
}));

let status: ((s: string) => void) | undefined;
const listMessages = vi.fn(async () => ({ messages: [], hasMore: false }));
vi.mock('@/lib/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat')>()),
  subscribeChat: (_sb: unknown, opts: { onStatus?: typeof status }) => {
    status = opts.onStatus;
    return () => {};
  },
  listMessages: (...args: unknown[]) => listMessages(...(args as [])),
}));
vi.mock('@/lib/session-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-cache')>()),
  prefetchSession: (_key: unknown, fetcher: () => Promise<unknown>) =>
    fetcher(),
}));

import { useChannelTimeline } from './use-channel-timeline';
import { useChatWorkspace, type ChatEvent } from './use-chat-workspace';

const CHANNEL = 'c0000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.useFakeTimers();
  refreshed.length = 0;
  listMessages.mockClear();
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
