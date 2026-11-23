import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import type { Notification } from '@/types';

// What the provider asks the database for. Every decision is in
// lib/notifications/store.ts and tested there.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  const react = mockReact(await importOriginal<typeof import('react')>());
  type Reducer = (state: unknown, action: unknown) => unknown;
  return {
    ...react,
    useReducer: (reducer: Reducer, initial: unknown) => {
      const [state, set] = react.useState(initial);
      return [
        state,
        (action: unknown) => set((s: unknown) => reducer(s, action)),
      ];
    },
  };
});
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

type Call = [method: string, ...args: unknown[]];
type Answer = { data?: unknown; count?: number; error: unknown };
/** Every request's builder calls, in the order they were sent. */
let sent: Call[][] = [];
/** The answer to the next list or update request; counts are separate. */
let answers: (Answer | Promise<Answer>)[] = [];
let unreadTotal = 0;
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const calls: Call[] = [];
      const q: unknown = new Proxy(
        {},
        {
          get: (_t, method: string) =>
            method === 'then'
              ? (resolve: (a: unknown) => void) => {
                  sent.push(calls);
                  const counting = calls.some(
                    ([m, , o]) => m === 'select' && !!o
                  );
                  resolve(
                    counting
                      ? { count: unreadTotal, error: null }
                      : (answers.shift() ?? { data: [], error: null })
                  );
                }
              : (...args: unknown[]) => {
                  calls.push([method, ...args]);
                  return q;
                },
        }
      );
      return q;
    },
  }),
}));

import { render, resetHooks, settle } from '@/test/hook-renderer';
import { NotificationsProvider } from './notifications-provider';

type Value = {
  notifications: Notification[] | null;
  unread: number;
  hasOlder: boolean;
  load: () => Promise<void>;
  loadOlder: () => Promise<void>;
  markAllRead: () => Promise<void>;
};
const bell = () =>
  (
    render(() => NotificationsProvider({ children: null })) as ReactElement<{
      value: Value;
    }>
  ).props.value;

const stamp = (n: number) =>
  `2026-10-27T10:00:00.${String(900_000 - n).padStart(6, '0')}+00:00`;
/** `count` rows, newest first, from the `from`th newest on. */
const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `id-${from + i}`,
    created_at: stamp(from + i),
  }));
const page = (from: number, count: number): Answer => ({
  data: rows(from, count),
  error: null,
});
const args = (calls: Call[], method: string) =>
  calls.filter(([m]) => m === method).map(([, ...a]) => a);
/** The last request that was not the unread count. */
const lastRequest = () =>
  sent.filter((c) => !c.some(([m, , o]) => m === 'select' && !!o)).at(-1)!;

beforeEach(() => {
  resetHooks();
  sent = [];
  answers = [];
  unreadTotal = 150;
  vi.clearAllMocks();
});

async function loadFirst() {
  answers = [page(0, 101)];
  await bell().load();
  bell();
}

describe('the list', () => {
  it('is read in one order, a row more than it shows', async () => {
    await loadFirst();
    expect(args(lastRequest(), 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(args(lastRequest(), 'limit')).toEqual([[101]]);
    expect(args(lastRequest(), 'or')).toEqual([]);
    expect(bell().notifications).toHaveLength(100);
    expect(bell().hasOlder).toBe(true);
  });

  it('continues after its last row, and a reload keeps the depth', async () => {
    await loadFirst();
    answers = [page(100, 50)];
    await bell().loadOlder();
    const { created_at } = rows(99, 1)[0];
    expect(args(lastRequest(), 'or')).toEqual([
      [
        `created_at.lt."${created_at}",and(created_at.eq."${created_at}",id.lt.id-99)`,
      ],
    ]);
    bell();
    expect(bell().notifications).toHaveLength(150);
    expect(bell()).toMatchObject({ hasOlder: false, unread: 150 });

    answers = [page(0, 150)];
    await bell().load();
    expect(args(lastRequest(), 'limit')).toEqual([[151]]);
    expect(bell().notifications).toHaveLength(150);
  });

  it('says so when the older ones did not load, and keeps the rest', async () => {
    await loadFirst();
    answers = [{ data: null, error: { message: 'timeout' } }];
    await bell().loadOlder();
    expect(toasts.error).toHaveBeenCalledWith('loadOlderFailed');
    expect(bell().notifications).toHaveLength(100);
    expect(bell().hasOlder).toBe(true);
  });
});

describe('mark all as read', () => {
  it('is bounded by the newest row loaded, as a string', async () => {
    await loadFirst();
    await bell().markAllRead();
    expect(args(lastRequest(), 'lte')).toEqual([['created_at', stamp(0)]]);
    expect(args(lastRequest(), 'is')).toEqual([['read_at', null]]);
    expect(bell().unread).toBe(0);
  });

  it('sends nothing before a list is loaded', async () => {
    await bell().markAllRead();
    expect(sent).toEqual([]);
  });

  it('and an older page never run together', async () => {
    await loadFirst();
    let land: (a: Answer) => void = () => {};
    const held = () => new Promise<Answer>((r) => (land = r));

    answers = [held()];
    const reading = bell().loadOlder();
    await settle();
    const before = sent.length;
    await bell().markAllRead();
    expect(sent).toHaveLength(before);
    land(page(100, 50));
    await reading;

    answers = [page(0, 151)];
    await bell().load();
    bell();
    answers = [held()];
    const marking = bell().markAllRead();
    await settle();
    const then = sent.length;
    await bell().loadOlder();
    expect(sent).toHaveLength(then);
    land({ error: null });
    await marking;
  });
});
