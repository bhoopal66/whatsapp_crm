import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here: a small stand-in for React's hooks keeps state and effects
// by position and renders again after a state set (as in
// screens-catch-up.test.tsx), so the hook can be called as a function.
type Slot = { v?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const rt = vi.hoisted(() => ({
  slots: [] as Slot[],
  cursor: 0,
  dirty: false,
  effects: [] as (() => void)[],
}));
vi.mock('react', async (importOriginal) => {
  const slot = (make: () => Slot) => {
    const i = rt.cursor++;
    return (rt.slots[i] ??= make());
  };
  const moved = (s: Slot, deps?: unknown[]) =>
    !deps || !s.deps || deps.some((d, k) => !Object.is(d, s.deps![k]));
  return {
    ...(await importOriginal<typeof import('react')>()),
    useState: (init: unknown) => {
      const s = slot(() => ({ v: typeof init === 'function' ? init() : init }));
      return [
        s.v,
        (next: unknown) => {
          const v = typeof next === 'function' ? next(s.v) : next;
          if (Object.is(v, s.v)) return;
          s.v = v;
          rt.dirty = true;
        },
      ];
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const s = slot(() => ({}));
      if (!moved(s, deps)) return;
      rt.effects.push(() => {
        s.cleanup?.();
        s.deps = deps;
        s.cleanup = effect();
      });
    },
  };
});

const auth = {
  accountId: 'acct-1',
  user: { id: 'user-a' } as { id: string } | null,
  accountRole: 'agent',
  profileLoading: false,
};
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));

type Answer = { data?: unknown; error: unknown };
let answer: Answer | Promise<Answer> = { data: [], error: null };
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: () => Promise.resolve(answer),
    channel: () => {
      const c: Record<string, unknown> = {};
      c.on = () => c;
      c.subscribe = () => c;
      return c;
    },
    removeChannel: async () => {},
  }),
}));

import { useMyCoordinatorShares } from './use-my-coordinator-shares';

let shown: unknown;
const useUnderTest = () => useMyCoordinatorShares();
const screen: () => unknown = useUnderTest;
const render = () => {
  for (let i = 0; i < 25; i++) {
    rt.dirty = false;
    rt.cursor = 0;
    shown = screen();
    rt.effects.splice(0).forEach((run) => run());
    if (!rt.dirty) return;
  }
  throw new Error('renders without end');
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await Promise.resolve();
    if (rt.dirty) render();
  }
};
const rows = (r: { conversation_id: string; bank_code: string }[]): Answer => ({
  data: r,
  error: null,
});
const BROKEN: Answer = { data: null, error: { message: '503' } };

beforeEach(() => {
  rt.slots.length = 0;
  Object.assign(auth, {
    accountId: 'acct-1',
    user: { id: 'user-a' },
    accountRole: 'agent',
    profileLoading: false,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rt.slots.splice(0).forEach((s) => s.cleanup?.());
  vi.restoreAllMocks();
});

describe('the chats shared with a coordinator', () => {
  it('shows the map read for this person', async () => {
    answer = rows([{ conversation_id: 'c1', bank_code: 'ADCB' }]);
    render();
    await settle();
    expect(shown).toEqual(new Map([['c1', 'ADCB']]));
  });

  it('does not show the previous person map while the new read runs', async () => {
    answer = rows([{ conversation_id: 'c1', bank_code: 'ADCB' }]);
    render();
    await settle();
    let release: (a: Answer) => void = () => {};
    answer = new Promise<Answer>((r) => (release = r));
    auth.user = { id: 'user-b' };
    render();
    await settle();
    expect(shown).toEqual(new Map());
    release(rows([{ conversation_id: 'c2', bank_code: 'FAB' }]));
    await settle();
    expect(shown).toEqual(new Map([['c2', 'FAB']]));
  });

  it('is none, not the previous workspace map, when the first read there fails', async () => {
    answer = rows([{ conversation_id: 'c1', bank_code: 'ADCB' }]);
    render();
    await settle();
    answer = BROKEN;
    auth.accountId = 'acct-2';
    render();
    await settle();
    expect(shown).toEqual(new Map());
  });

  it('keeps its own last map when a later read of the same person fails', async () => {
    answer = rows([{ conversation_id: 'c1', bank_code: 'ADCB' }]);
    render();
    await settle();
    answer = BROKEN;
    auth.accountRole = 'agent';
    // Same key, a new read (the effect runs again on a changed token).
    rt.slots.forEach((s) => s.cleanup?.());
    rt.slots.forEach((s) => (s.deps = undefined));
    render();
    await settle();
    expect(shown).toEqual(new Map([['c1', 'ADCB']]));
  });
});
