import { afterEach, describe, expect, it, vi } from 'vitest';

// The test environment has no DOM, so React's hooks are stood in for:
// state is its initial value and an effect runs at once, which is all
// the subscription under test needs. Its cleanup is kept to run after.
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
  useCallback: (fn: unknown) => fn,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acct-1' }),
}));

const topics: string[] = [];
const removed: string[] = [];
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (topic: string) => {
      topics.push(topic);
      const channel = { topic, on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: (channel: { topic: string }) => {
      removed.push(channel.topic);
      return Promise.resolve('ok');
    },
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  }),
}));

import { usePresence } from './use-presence';

afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  topics.length = 0;
  removed.length = 0;
});

describe('usePresence', () => {
  it('subscribes on a topic of its own, so a remount is not handed the channel still leaving', () => {
    usePresence();
    cleanups.splice(0).forEach((fn) => fn()); // the customer page's key changes
    usePresence();
    expect(topics).toHaveLength(2);
    expect(topics[0]).toMatch(/^presence:acct-1:/);
    expect(topics[1]).toMatch(/^presence:acct-1:/);
    expect(topics[1]).not.toBe(topics[0]);
    expect(removed).toEqual([topics[0]]);
  });

  it('opens nothing while disabled', () => {
    usePresence(false);
    expect(topics).toEqual([]);
  });
});
