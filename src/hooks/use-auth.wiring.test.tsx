import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here: React's hooks are stood in for by a one-component
// renderer (as in use-session-query.test.ts). `auth()` renders the
// provider once more and returns the context value it would hand out.
const react = vi.hoisted(() => ({
  slots: [] as { value: unknown }[],
  index: 0,
  cleanups: [] as (() => void)[],
}));
function slot(init: () => unknown) {
  const i = react.index++;
  return (react.slots[i] ??= { value: init() });
}
const changed = (a?: unknown[], b?: unknown[]) =>
  !a || !b || b.some((dep, i) => !Object.is(dep, a[i]));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => {
    const s = slot(() => init);
    return [
      s.value,
      (next: unknown) => {
        s.value = typeof next === 'function' ? next(s.value) : next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const s = slot(() => undefined);
    if (!changed(s.value as unknown[] | undefined, deps)) return;
    s.value = deps;
    const cleanup = effect();
    if (cleanup) react.cleanups.push(cleanup);
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => slot(() => fn).value,
  useRef: (value: unknown) => slot(() => ({ current: value })).value,
}));
vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const ROW = {
  id: 'p1',
  full_name: 'A',
  account_id: 'acct-1',
  account_role: 'admin',
  department: 'sales',
  is_active: true,
  deactivated_at: null as string | null,
};
type Answer = {
  data: { session: { user: { id: string } } | null };
  error: unknown;
};
const IN: Answer = { data: { session: { user: { id: 'u1' } } }, error: null };
const NOBODY: Answer = { data: { session: null }, error: null };
const UNKNOWN: Answer = {
  data: { session: null },
  error: { name: 'AuthRetryableFetchError', status: 0 },
};
const db = vi.hoisted(() => ({
  session: undefined as unknown,
  signOutError: null as unknown,
  rows: [] as unknown[],
  rowsError: null as unknown,
  profileReads: 0,
  restricted: { data: false, error: null } as unknown,
  emit: (() => {}) as (event: string, session: unknown) => void,
  signOut: null as unknown as (...a: unknown[]) => Promise<unknown>,
  getSession: null as unknown as (...a: unknown[]) => Promise<unknown>,
}));
vi.mock('@/lib/supabase/client', () => {
  const client = {
    auth: {
      getSession: (...a: unknown[]) => db.getSession(...a),
      signOut: (...a: unknown[]) => db.signOut(...a),
      onAuthStateChange: (cb: typeof db.emit) => {
        db.emit = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    rpc: async (name: string) =>
      name === 'department_restricted'
        ? db.restricted
        : { data: [], error: null },
    from: (table: string) => ({
      select: () =>
        Object.assign(Promise.resolve({ data: [], error: null }), {
          eq: async () => {
            if (table !== 'profiles') return { data: [], error: null };
            db.profileReads += 1;
            return { data: db.rows, error: db.rowsError };
          },
        }),
    }),
  };
  return { createClient: () => client };
});

import { resetSessionCacheForTests } from '@/lib/session-cache';
import { AuthProvider } from './use-auth';

function auth() {
  react.index = 0;
  const el = AuthProvider({ children: null }) as unknown as {
    props: { value: ReturnType<typeof import('./use-auth').useAuth> };
  };
  return el.props.value;
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

const listeners: Record<string, (() => void)[]> = {};
const on = (name: string, fn: () => void) =>
  void (listeners[name] ??= []).push(fn);
const fire = (name: string) => listeners[name]?.forEach((fn) => fn());
const location = { href: '', assign: vi.fn(), reload: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  react.slots = [];
  react.cleanups = [];
  for (const name of Object.keys(listeners)) delete listeners[name];
  resetSessionCacheForTests();
  Object.assign(location, { href: '' });
  vi.stubGlobal('window', {
    location,
    localStorage: undefined,
    addEventListener: on,
    removeEventListener() {},
  });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: on,
    removeEventListener() {},
  });
  vi.stubGlobal('BroadcastChannel', undefined);
  db.session = IN;
  db.signOutError = null;
  db.rows = [{ ...ROW }];
  db.rowsError = null;
  db.profileReads = 0;
  db.getSession = vi.fn(async () => db.session);
  db.signOut = vi.fn(async () => ({ error: db.signOutError }));
});
afterEach(() => {
  react.cleanups.forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function start() {
  auth();
  await tick();
  return auth();
}

describe('signing out', () => {
  it('ends this device only, then loads /login', async () => {
    const { signOut } = await start();
    await signOut();
    expect(db.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(location.href).toBe('/login');
    expect(auth().user).toBeNull();
  });

  it('says so and stays when the session is still there', async () => {
    const { signOut } = await start();
    db.signOutError = new Error('refused');
    await signOut();
    expect(toast.error).toHaveBeenCalledWith('signOutFailed');
    expect(location.href).toBe('');
    expect(auth()).toMatchObject({ user: { id: 'u1' }, signingOut: false });
  });
});
