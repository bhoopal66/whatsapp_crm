import { afterEach, describe, expect, it, vi } from 'vitest';

// The test environment has no DOM, so React's hooks are stood in for
// (as in use-presence.test.ts): state is its initial value and an
// effect runs at once. Its cleanup is kept to run after.
const cleanups: (() => void)[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [
    typeof init === 'function' ? (init as () => unknown)() : init,
    () => {},
  ],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useMemo: (fn: () => unknown) => fn(),
  useRef: (current: unknown) => ({ current }),
}));

let accountId: string | null = null;
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId }) }));
vi.mock('@/hooks/use-ai-auto-reply-live', () => ({
  useAiAutoReplyLive: () => false,
}));

const topics: string[] = [];
const bindings: { topic: string; filter: Record<string, unknown> }[] = [];
const removed: string[] = [];
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (topic: string) => {
      topics.push(topic);
      const channel = {
        topic,
        on: (_type: string, filter: Record<string, unknown>) => {
          bindings.push({ topic, filter });
          return channel;
        },
        subscribe: () => channel,
      };
      return channel;
    },
    removeChannel: (channel: { topic: string }) => {
      removed.push(channel.topic);
      return Promise.resolve('ok');
    },
    from: () => ({
      select: () => ({
        gt: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  }),
}));

import { useUnreadChats } from './use-total-unread';

const A = '0b6f1c9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';
const B = '1c7f2d0f-3e4b-4c6d-9e8f-0a1b2c3d4e5f';

afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  topics.length = 0;
  bindings.length = 0;
  removed.length = 0;
  accountId = null;
});

describe('useUnreadChats', () => {
  it('opens no channel while the account is unknown', () => {
    useUnreadChats();
    expect(topics).toEqual([]);
  });

  it("listens only to the active account's conversations, DELETE aside", () => {
    accountId = A;
    useUnreadChats();
    expect(bindings.map((b) => b.filter)).toEqual([
      {
        event: 'INSERT',
        schema: 'public',
        table: 'conversations',
        filter: `account_id=eq.${A}`,
      },
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'conversations',
        filter: `account_id=eq.${A}`,
      },
      { event: 'DELETE', schema: 'public', table: 'conversations' },
    ]);
  });

  it('re-subscribes on a topic of its own after a workspace switch', () => {
    accountId = A;
    useUnreadChats();
    cleanups.splice(0).forEach((fn) => fn()); // accountId changed
    accountId = B;
    useUnreadChats();
    expect(topics).toEqual([
      `total-unread-realtime:${A}`,
      `total-unread-realtime:${B}`,
    ]);
    expect(removed).toEqual([`total-unread-realtime:${A}`]);
    expect(bindings.filter((b) => b.topic.endsWith(B))[0].filter).toEqual(
      expect.objectContaining({ filter: `account_id=eq.${B}` })
    );
  });
});
