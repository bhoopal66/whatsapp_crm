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
  useCallback: (fn: unknown, deps?: unknown[]) => {
    const s = slot(() => undefined) as {
      value: { fn: unknown; deps?: unknown[] } | undefined;
    };
    if (changed(s.value?.deps, deps)) s.value = { fn, deps };
    return s.value!.fn;
  },
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
  /** Set: the next profile reads answer once it resolves. */
  hold: null as Promise<void> | null,
  restricted: { data: false, error: null } as unknown,
  emit: (() => {}) as (event: string, session: unknown) => void,
  signOut: null as unknown as import('vitest').Mock<
    (...a: unknown[]) => Promise<unknown>
  >,
  getSession: null as unknown as import('vitest').Mock<
    (...a: unknown[]) => Promise<unknown>
  >,
}));
vi.mock('@/lib/supabase/client', () => {
  const ACCOUNTS = [
    { id: 'acct-1', name: 'One', default_currency: 'AED' },
    { id: 'acct-2', name: 'Two', default_currency: 'AED' },
  ];
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
        Object.assign(Promise.resolve({ data: ACCOUNTS, error: null }), {
          eq: async () => {
            if (table !== 'profiles') return { data: [], error: null };
            db.profileReads += 1;
            const answer = { data: db.rows, error: db.rowsError };
            await db.hold;
            return answer;
          },
        }),
    }),
  };
  return { createClient: () => client };
});

import { leaveSession, resetSessionCacheForTests } from '@/lib/session-cache';
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
  db.hold = null;
  db.restricted = { data: false, error: null };
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

describe('a session that cannot be read yet', () => {
  it('is never nobody: it waits, says so after 3 s and asks again', async () => {
    db.session = UNKNOWN;
    await start();
    db.emit('INITIAL_SESSION', null);
    await tick(3_000);
    expect(auth()).toMatchObject({
      user: null,
      loading: true,
      sessionStalled: true,
      profileLoading: true,
    });
    const asked = db.getSession.mock.calls.length;
    db.session = IN;
    await tick(30_000);
    expect(db.getSession.mock.calls.length).toBe(asked + 1);
    expect(auth()).toMatchObject({
      user: { id: 'u1' },
      loading: false,
      sessionStalled: false,
    });
  });

  it.each(['visibilitychange', 'online'])(
    'asks at once on %s',
    async (name) => {
      db.session = UNKNOWN;
      await start();
      await tick(20_000);
      db.session = IN;
      fire(name);
      await tick();
      expect(auth()).toMatchObject({ user: { id: 'u1' }, loading: false });
    }
  );

  it('is signed out once that is the answer, or the event', async () => {
    db.session = NOBODY;
    expect(await start()).toMatchObject({ user: null, loading: false });
    react.slots = [];
    db.session = UNKNOWN;
    await start();
    db.emit('SIGNED_OUT', null);
    expect(auth()).toMatchObject({ user: null, loading: false });
  });
});

describe('a change made elsewhere', () => {
  const AGENT = { ...ROW, account_role: 'agent' };
  const OTHER = {
    ...ROW,
    id: 'p2',
    account_id: 'acct-2',
    account_role: 'agent',
  };
  const AWAY = [{ ...ROW, is_active: false }, OTHER];
  const SWITCHED = { kind: 'switched', role: 'agent' };
  const token = async () => {
    db.emit('TOKEN_REFRESHED', { user: { id: 'u1' } });
    await tick();
    return auth();
  };
  /** The next reads wait for `release`, which lets them answer. */
  const holdReads = () => {
    let release = () => {};
    db.hold = new Promise<void>((resolve) => (release = resolve));
    return async () => {
      release();
      db.hold = null;
      await tick();
    };
  };

  it('is looked for when the tab is shown, once per 120 s', async () => {
    await start();
    expect(db.profileReads).toBe(1);
    const shown = async (ms = 0) => {
      await tick(ms);
      fire('visibilitychange');
      await tick();
      return db.profileReads;
    };
    expect(await shown()).toBe(2);
    expect(await shown(119_000)).toBe(2);
    (document as { visibilityState: string }).visibilityState = 'hidden';
    expect(await shown(2_000)).toBe(2);
    (document as { visibilityState: string }).visibilityState = 'visible';
    expect(await shown()).toBe(3);
  });

  it('is looked for on a refreshed token, and only then on an event', async () => {
    await start();
    db.emit('SIGNED_IN', { user: { id: 'u1' } });
    await tick();
    expect(db.profileReads).toBe(1);
    await token();
    await token();
    expect(db.profileReads).toBe(3);
  });

  it('is nothing to act on when nothing changed', async () => {
    const before = await start();
    const after = await token();
    expect(after.profile).toBe(before.profile);
    expect(after.profileNotice).toBeNull();
  });

  it('says the workspace was switched and loads it, telling nobody', async () => {
    const posted = vi.fn();
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage = posted;
        close() {}
      }
    );
    const before = await start();
    db.rows = AWAY;
    const after = await token();
    expect(after.profileNotice).toEqual(SWITCHED);
    expect(after).toMatchObject({ accountId: 'acct-1', profileLoading: false });
    expect(after.profile).toBe(before.profile);
    expect(location.assign).not.toHaveBeenCalled();
    after.followProfileNotice();
    expect(location.assign).toHaveBeenCalledWith('/worklist');
    expect(posted).not.toHaveBeenCalled();
  });

  it('can be dismissed, comes back, and goes when switched back', async () => {
    await start();
    db.rows = AWAY;
    (await token()).dismissProfileNotice();
    expect(auth().profileNotice).toBeNull();
    expect((await token()).profileNotice).toEqual(SWITCHED);
    db.rows = [{ ...ROW }];
    expect((await token()).profileNotice).toBeNull();
  });

  it('says a deactivation and reloads, nothing else', async () => {
    await start();
    db.rows = [{ ...ROW, deactivated_at: '2026-11-24T10:00:00Z' }];
    const after = await token();
    expect(after.profileNotice).toEqual({ kind: 'deactivated' });
    expect(db.signOut).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
    after.followProfileNotice();
    expect(location.reload).toHaveBeenCalledOnce();
    expect(location.assign).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', AWAY, { message: 'timeout' }],
    ['empty', [], null],
    ['unreadable', null, null],
    ['without an active row', [{ ...OTHER, is_active: false }], null],
  ])('ignores an answer that is %s', async (_name, rows, error) => {
    const before = await start();
    db.rows = rows as unknown[];
    db.rowsError = error;
    const quiet = await token();
    expect(quiet.profileNotice).toBeNull();
    expect(quiet.profile).toBe(before.profile);

    // Nor does it take back what a good answer said.
    db.rows = AWAY;
    db.rowsError = null;
    await token();
    db.rows = rows as unknown[];
    db.rowsError = error;
    expect((await token()).profileNotice).toEqual(SWITCHED);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('drops an answer that comes after the profile was read again', async () => {
    await start();
    db.rows = AWAY;
    const release = holdReads();
    await token();
    db.rows = [{ ...ROW }];
    db.hold = null;
    await auth().refreshProfile();
    await release();
    expect(auth().profileNotice).toBeNull();
  });

  it('drops an answer that comes after another user signed in', async () => {
    await start();
    db.rows = AWAY;
    const release = holdReads();
    await token();
    db.rows = [{ ...OTHER, id: 'p9', account_id: 'acct-1' }];
    db.hold = null;
    db.emit('SIGNED_IN', { user: { id: 'u2' } });
    await tick();
    await release();
    expect(auth()).toMatchObject({
      profileNotice: null,
      profile: { id: 'p9' },
    });
  });

  it('drops an answer that comes after the sign-out', async () => {
    await start();
    db.rows = AWAY;
    const release = holdReads();
    await token();
    db.emit('SIGNED_OUT', null);
    await release();
    expect(auth().profileNotice).toBeNull();
  });

  it('drops an answer to a page that is leaving', async () => {
    await start();
    db.rows = [AGENT];
    const release = holdReads();
    await token();
    leaveSession();
    await release();
    expect(auth().accountRole).toBe('admin');
  });

  it('drops a role when the page leaves while its department is read', async () => {
    await start();
    db.rows = [AGENT];
    let release: (answer: unknown) => void = () => {};
    db.restricted = new Promise((resolve) => (release = resolve));
    await token();
    leaveSession();
    release({ data: false, error: null });
    await tick();
    expect(auth().accountRole).toBe('admin');
  });

  it('drops an answer that a later one overtook', async () => {
    await start();
    const release = holdReads();
    await token();
    db.rows = AWAY;
    db.hold = null;
    expect((await token()).profileNotice).toEqual(SWITCHED);
    await release();
    expect(auth().profileNotice).toEqual(SWITCHED);
  });

  it('takes a new role and department in place', async () => {
    await start();
    db.rows = [{ ...AGENT, department: 'hr', may_review_all_calls: true }];
    db.restricted = { data: true, error: null };
    expect(await token()).toMatchObject({
      accountRole: 'agent',
      department: 'hr',
      salesRestricted: true,
      reviewsAllCalls: true,
      canManageMembers: false,
      profileLoading: false,
      profileNotice: null,
      profile: { id: 'p1', full_name: 'A' },
    });
    // And back: the next check compares with the new profile.
    db.rows = [{ ...ROW }];
    db.restricted = { data: null, error: { message: 'not asked for admins' } };
    expect(await token()).toMatchObject({
      accountRole: 'admin',
      department: 'sales',
      salesRestricted: false,
    });
  });

  it('waits when whether the department is restricted is not known', async () => {
    await start();
    db.rows = [{ ...AGENT, department: 'hr' }];
    for (const answer of [
      { data: null, error: { message: 'timeout' } },
      { data: null, error: null },
    ]) {
      db.restricted = answer;
      expect(await token()).toMatchObject({
        accountRole: 'admin',
        department: 'sales',
        salesRestricted: false,
      });
    }
    db.restricted = { data: true, error: null };
    expect(await token()).toMatchObject({
      accountRole: 'agent',
      salesRestricted: true,
    });
  });
});
