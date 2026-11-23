import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here: React's hooks are stood in for, as in
// use-total-unread.test.ts. An effect runs at once; every state set is
// kept, in order, in `sets`.
const cleanups: (() => void)[] = [];
let sets: unknown[] = [];
let reduced: unknown = null;
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => {
    const slot = { v: typeof init === 'function' ? init() : init };
    return [
      slot.v,
      (next: unknown) => {
        slot.v = typeof next === 'function' ? next(slot.v) : next;
        sets.push(slot.v);
      },
    ];
  },
  useReducer: (
    reducer: (s: unknown, a: unknown) => unknown,
    initial: unknown
  ) => {
    reduced = initial;
    return [initial, (a: unknown) => (reduced = reducer(reduced, a))];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
}));

const ACCOUNT = '0b6f1c9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';
const USER = '1c7f2d0f-3e4b-4c6d-9e8f-0a1b2c3d4e5f';
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: ACCOUNT, user: { id: USER } }),
}));
vi.mock('@/hooks/use-ai-auto-reply-live', () => ({
  useAiAutoReplyLive: () => false,
}));
vi.mock('@/hooks/use-whatsapp-numbers', () => ({ useMyNumberIds: () => [] }));
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));

type Answer = { data?: unknown; count?: number; error: unknown };
let answers: Answer[] = [];
let reads = 0;
type Handler = (payload: unknown) => void;
let handlers: Handler[] = [];
let tables: string[] = [];
let status: ((s: string) => void) | undefined;
vi.mock('@/lib/supabase/client', () => {
  const query = () => {
    const q: unknown = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'then'
            ? (resolve: (a: Answer) => void) => {
                reads += 1;
                const answer = answers.shift();
                // No answer queued: the read stays in flight.
                if (answer) resolve(answer);
              }
            : () => q,
      }
    );
    return q;
  };
  return {
    createClient: () => ({
      from: query,
      rpc: query,
      removeChannel: () => Promise.resolve('ok'),
      channel: () => {
        const channel = {
          on: (_t: string, f: { table?: string }, fn: Handler) => {
            handlers.push(fn);
            tables.push(f.table ?? '');
            return channel;
          },
          subscribe: (fn?: (s: string) => void) => {
            status = fn;
            return channel;
          },
        };
        return channel;
      },
    }),
  };
});

import { useConversationNotes } from '@/components/inbox/use-conversation-notes';
import { NotificationsProvider } from '@/components/notifications/notifications-provider';
import { useChatUnreadTotal } from './use-chat-unread-total';
import { useUnreadChats } from './use-total-unread';

const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const rejoin = async () => {
  await later(10_000);
  status?.('CHANNEL_ERROR');
  status?.('SUBSCRIBED');
  await later(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  answers = [];
  reads = 0;
  handlers = [];
  tables = [];
  status = undefined;
  sets = [];
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});

const screens: [string, () => unknown, Answer][] = [
  ['the unread badges', () => useUnreadChats(), { data: [], error: null }],
  [
    'the team chat badge',
    () => useChatUnreadTotal(),
    { data: [], error: null },
  ],
  [
    'the team notes',
    () => useConversationNotes(ACCOUNT),
    { data: [], error: null },
  ],
  [
    'the bell',
    () => NotificationsProvider({ children: null }),
    { count: 0, error: null },
  ],
];

describe.each(screens)('%s', (_name, mount, ok) => {
  it('reads once at first, and again on a rejoin', async () => {
    answers = [ok, ok];
    mount();
    status?.('SUBSCRIBED');
    await later(60_000);
    expect(reads).toBe(1);
    await rejoin();
    expect(reads).toBe(2);
  });

  it('retries a failed first read', async () => {
    answers = [{ data: null, error: { message: '503' } }, ok];
    mount();
    await later(60_000);
    expect(reads).toBe(2);
  });

  it('stops with the screen', async () => {
    answers = [{ data: null, error: { message: '503' } }];
    mount();
    cleanups.splice(0).forEach((fn) => fn());
    await rejoin();
    await later(60_000);
    expect(reads).toBe(1);
  });
});

describe('the unread badges', () => {
  const unread = (id: string, unread_count: number) => ({ id, unread_count });
  const heldIds = () => [...(sets.at(-1) as Map<string, unknown>).keys()];

  it('drop a chat the viewer lost, and keep the rows on a failed read', async () => {
    answers = [
      { data: [unread('a', 1), unread('lost', 2)], error: null },
      { data: null, error: { message: '503' } },
      { data: [unread('a', 1)], error: null },
    ];
    useUnreadChats();
    status?.('SUBSCRIBED');
    await later(0);
    expect(heldIds()).toEqual(['a', 'lost']);
    await rejoin(); // the failed one
    expect(heldIds()).toEqual(['a', 'lost']);
    await later(5_000);
    expect(heldIds()).toEqual(['a']);
  });

  it('keep an event that arrived while a read was in flight', async () => {
    const rises: string[] = [];
    answers = [{ data: [unread('b', 1)], error: null }];
    useUnreadChats((r) => rises.push(r.id));
    handlers[0]({ eventType: 'INSERT', new: unread('a', 1), old: {} });
    await later(0);
    expect(heldIds().sort()).toEqual(['a', 'b']);
    expect(rises).toEqual(['a']);
  });
});

describe('the team chat badge', () => {
  it("reads again for the viewer's own read mark, not for other people's", async () => {
    answers = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    useChatUnreadTotal();
    status?.('SUBSCRIBED');
    await later(0);
    expect(reads).toBe(1);
    const own = handlers[tables.indexOf('chat_channel_members')];
    own({
      eventType: 'UPDATE',
      new: { channel_id: 'c', user_id: 'someone-else' },
      old: {},
    });
    await later(5_000);
    expect(reads).toBe(1);
    own({
      eventType: 'UPDATE',
      new: { channel_id: 'c', user_id: USER },
      old: {},
    });
    await later(5_000);
    expect(reads).toBe(2);
  });
});

describe('the team notes', () => {
  it('keep what is on screen when a catch-up read fails', async () => {
    const note = { id: 'n', created_at: '2026-01-01T00:00:00Z' };
    answers = [
      { data: [note], error: null },
      { data: null, error: { message: '503' } },
    ];
    useConversationNotes(ACCOUNT);
    status?.('SUBSCRIBED');
    await later(0);
    await rejoin();
    expect(reads).toBe(2);
    expect(sets).toEqual([{ conversationId: ACCOUNT, notes: [note] }]);
  });
});

describe('the bell', () => {
  it('counts again after a gap', async () => {
    answers = [
      { count: 2, error: null },
      { count: 5, error: null },
    ];
    NotificationsProvider({ children: null });
    status?.('SUBSCRIBED');
    await later(0);
    expect(reduced).toMatchObject({ outsideUnread: 2 });
    await rejoin();
    expect(reduced).toMatchObject({ outsideUnread: 5 });
  });
});
