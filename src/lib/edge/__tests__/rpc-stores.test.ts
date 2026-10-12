/**
 * The Rpc*Store classes are thin: build the argument object for one of
 * migration 084's functions, call it through supabase `rpc()`, validate
 * the answer. These tests fake the client at that boundary and pin the
 * contract with the SQL (function names, `p_*` argument names, when
 * `p_now` is sent, which row shapes are accepted) and what a failure does
 * to each caller's policy.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardAdmin, type AdminCtx } from '../admin';
import { AuthLockout, RpcLockoutStore, type LockoutConfig } from '../lockout';
import { DEFAULT_SCOPES, RateLimiter, RpcRateStore } from '../ratelimit';
import { ReplayGuard, RpcSeenStore } from '../replay';
import type { RpcClockOptions } from '../rpc';

type Args = Record<string, unknown>;
type Answer = { data: unknown; error: { message: string } | null };

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const T0_ISO = '2026-10-04T10:00:00.000Z';

const ok = (data: unknown): Answer => ({ data, error: null });
const rpcError = (message: string): Answer => ({
  data: null,
  error: { message },
});

/**
 * A client that only knows `rpc()`. `answer` may throw to simulate a
 * transport failure (the returned promise then rejects).
 */
function fakeClient(answer: Answer | ((name: string, args: Args) => Answer)) {
  const rpc = vi.fn(async (name: string, args: Args) =>
    typeof answer === 'function' ? answer(name, args) : answer
  );
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}
type FakeRpc = ReturnType<typeof fakeClient>['rpc'];

/** Exactly one call, to `name`, with exactly `args` (an `undefined`-valued key is not "absent"). */
function expectOneCall(rpc: FakeRpc, name: string, args: Args) {
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0]).toStrictEqual([name, args]);
}

/** How a RETURNS TABLE answer may arrive: PostgREST sends an array, a client may unwrap it. */
const shapes = (row: Args) => [
  { shape: 'a one-row array', data: [row] as unknown },
  { shape: 'a bare object', data: row as unknown },
];

/** Answers that carry no row at all. */
const NO_ROW: Array<[string, unknown]> = [
  ['an empty array', []],
  ['null', null],
  ['undefined', undefined],
  ['[null]', [null]],
  ['a string', 'allowed'],
  ['a number', 42],
];

type NowCase = {
  name: string;
  opts: RpcClockOptions | undefined;
  now: number | undefined;
  pNow: string | undefined;
};
/** `now` handed to a store method vs the `p_now` that reaches the database. */
const NOW_CASES: NowCase[] = [
  {
    name: 'useCallerClock: true + a time → p_now is that time as ISO-8601',
    opts: { useCallerClock: true },
    now: T0,
    pNow: T0_ISO,
  },
  {
    name: 'useCallerClock: true + the epoch → p_now is sent (0 is a time)',
    opts: { useCallerClock: true },
    now: 0,
    pNow: '1970-01-01T00:00:00.000Z',
  },
  {
    name: 'useCallerClock: true + no time → no p_now (database clock)',
    opts: { useCallerClock: true },
    now: undefined,
    pNow: undefined,
  },
  {
    name: 'useCallerClock: false + a time → no p_now',
    opts: { useCallerClock: false },
    now: T0,
    pNow: undefined,
  },
  {
    name: 'empty options + a time → no p_now',
    opts: {},
    now: T0,
    pNow: undefined,
  },
  {
    name: 'no options + a time → no p_now',
    opts: undefined,
    now: T0,
    pNow: undefined,
  },
];
const withNow = (pNow: string | undefined): { p_now?: string } =>
  pNow === undefined ? {} : { p_now: pNow };

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
// RpcRateStore → edge_rate_check
// ---------------------------------------------------------------------

describe('RpcRateStore', () => {
  const ARGS = {
    p_scope: 'webhook.number',
    p_key: 'n1',
    p_limit: 4,
    p_window_ms: 1000,
  };
  const ROW = { allowed: true, remaining: 3, retry_after_ms: 0 };
  const hit = (store: RpcRateStore, now?: number) =>
    store.hit('webhook.number', 'n1', 4, 1000, now);

  it('calls edge_rate_check with exactly the named arguments', async () => {
    const { client, rpc } = fakeClient(ok([ROW]));
    await hit(new RpcRateStore(client));
    expectOneCall(rpc, 'edge_rate_check', ARGS);
  });

  describe('p_now is sent only when built with useCallerClock: true', () => {
    it.each(NOW_CASES)('$name', async ({ opts, now, pNow }) => {
      const { client, rpc } = fakeClient(ok([ROW]));
      await hit(new RpcRateStore(client, opts), now);
      expectOneCall(rpc, 'edge_rate_check', { ...ARGS, ...withNow(pNow) });
    });
  });

  it.each(shapes(ROW))(
    'maps an allowed row sent as $shape',
    async ({ data }) => {
      const { client } = fakeClient(ok(data));
      expect(await hit(new RpcRateStore(client))).toStrictEqual({
        allowed: true,
        remaining: 3,
        retryAfterMs: 0,
      });
    }
  );

  it.each(shapes({ allowed: false, remaining: 0, retry_after_ms: 600 }))(
    'maps a refused row sent as $shape',
    async ({ data }) => {
      const { client } = fakeClient(ok(data));
      expect(await hit(new RpcRateStore(client))).toStrictEqual({
        allowed: false,
        remaining: 0,
        retryAfterMs: 600,
      });
    }
  );

  it.each(NO_ROW)('throws when the answer is %s', async (_name, data) => {
    const { client } = fakeClient(ok(data));
    await expect(hit(new RpcRateStore(client))).rejects.toThrow(
      'edge_rate_check returned no row'
    );
  });

  it.each<[string, unknown]>([
    ['an empty object', {}],
    ['allowed as a string', { ...ROW, allowed: 'true' }],
    ['remaining as a string', { ...ROW, remaining: '3' }],
    ['retry_after_ms as a string', { ...ROW, retry_after_ms: '0' }],
    ['retry_after_ms null', { ...ROW, retry_after_ms: null }],
    ['retry_after_ms missing', { allowed: true, remaining: 3 }],
  ])('throws on a malformed row: %s', async (_name, row) => {
    const { client } = fakeClient(ok([row]));
    await expect(hit(new RpcRateStore(client))).rejects.toThrow(
      'edge_rate_check returned a malformed row'
    );
  });

  it('turns an RPC error into a thrown Error naming the function', async () => {
    const { client } = fakeClient(rpcError('connection refused'));
    await expect(hit(new RpcRateStore(client))).rejects.toThrow(
      'edge_rate_check failed: connection refused'
    );
  });
});

describe('RateLimiter over RpcRateStore', () => {
  it.each(Object.entries(DEFAULT_SCOPES))(
    '%s: the scope’s limit and window reach the database',
    async (scope, cfg) => {
      const { client, rpc } = fakeClient(
        ok([{ allowed: true, remaining: 1, retry_after_ms: 0 }])
      );
      await new RateLimiter(new RpcRateStore(client)).check(scope, 'k1');
      expectOneCall(rpc, 'edge_rate_check', {
        p_scope: scope,
        p_key: 'k1',
        p_limit: cfg.limit,
        p_window_ms: cfg.windowMs,
      });
    }
  );

  it('relays the database decision as-is, without a degraded flag', async () => {
    const allowed = fakeClient(
      ok([{ allowed: true, remaining: 3, retry_after_ms: 0 }])
    );
    expect(
      await new RateLimiter(new RpcRateStore(allowed.client)).check(
        'webhook.number',
        'k'
      )
    ).toStrictEqual({ allowed: true, remaining: 3, retryAfterMs: 0 });

    const refused = fakeClient(
      ok([{ allowed: false, remaining: 0, retry_after_ms: 600 }])
    );
    expect(
      await new RateLimiter(new RpcRateStore(refused.client)).check(
        'admin.ip',
        'k'
      )
    ).toStrictEqual({ allowed: false, remaining: 0, retryAfterMs: 600 });
  });

  const FAILURES = [
    {
      name: 'an RPC error',
      makeClient: () => fakeClient(rpcError('db down')),
      err: 'edge_rate_check failed: db down',
    },
    {
      name: 'a thrown error',
      makeClient: () =>
        fakeClient(() => {
          throw new Error('socket hang up');
        }),
      err: 'socket hang up',
    },
    {
      name: 'an empty answer',
      makeClient: () => fakeClient(ok([])),
      err: 'edge_rate_check returned no row',
    },
    {
      name: 'a malformed row',
      makeClient: () => fakeClient(ok([{ allowed: 'yes' }])),
      err: 'edge_rate_check returned a malformed row',
    },
  ];

  describe.each(FAILURES)('$name', ({ makeClient, err }) => {
    it.each(['webhook.number', 'webhook.ip'] as const)(
      '%s fails open: allowed, degraded, and warns',
      async (scope) => {
        const { client, rpc } = makeClient();
        const log = { warn: vi.fn() };
        const decision = await new RateLimiter(
          new RpcRateStore(client),
          DEFAULT_SCOPES,
          log
        ).check(scope, 'k1');
        expect(decision).toStrictEqual({
          allowed: true,
          remaining: 0,
          retryAfterMs: 0,
          degraded: true,
        });
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringMatching(/failing open/),
          { scope, key: 'k1', err: expect.stringContaining(err) }
        );
      }
    );

    it.each(['admin.ip', 'admin.user'] as const)(
      '%s fails closed: refused for one window, degraded, and warns',
      async (scope) => {
        const { client } = makeClient();
        const log = { warn: vi.fn() };
        const decision = await new RateLimiter(
          new RpcRateStore(client),
          DEFAULT_SCOPES,
          log
        ).check(scope, 'k1');
        expect(decision).toStrictEqual({
          allowed: false,
          remaining: 0,
          retryAfterMs: DEFAULT_SCOPES[scope].windowMs,
          degraded: true,
        });
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringMatching(/failing closed/),
          { scope, key: 'k1', err: expect.stringContaining(err) }
        );
      }
    );
  });

  it('with no logger injected, the degradation goes to console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeClient(rpcError('db down'));
    const decision = await new RateLimiter(new RpcRateStore(client)).check(
      'webhook.ip',
      'k1'
    );
    expect(decision).toMatchObject({ allowed: true, degraded: true });
    expect(warn).toHaveBeenCalledWith(
      '[edge] rate-limit store failed; failing open',
      expect.objectContaining({ scope: 'webhook.ip', key: 'k1' })
    );
  });
});

// ---------------------------------------------------------------------
// RpcSeenStore → edge_replay_claim / _confirm / _release
// ---------------------------------------------------------------------

describe('RpcSeenStore', () => {
  const CLAIM_ARGS = { p_key: 'msg:1', p_token: 'tok-1', p_lease_seconds: 60 };
  const CONFIRM_ARGS = {
    p_key: 'msg:1',
    p_token: 'tok-1',
    p_ttl_seconds: 86_400,
  };
  const RELEASE_ARGS = { p_key: 'msg:1', p_token: 'tok-1' };

  describe('claim', () => {
    it('calls edge_replay_claim with exactly the named arguments', async () => {
      const { client, rpc } = fakeClient(ok('new'));
      await new RpcSeenStore(client).claim('msg:1', 'tok-1', 60);
      expectOneCall(rpc, 'edge_replay_claim', CLAIM_ARGS);
    });

    it.each(['new', 'inflight', 'done'] as const)(
      'relays the state %s',
      async (state) => {
        const { client } = fakeClient(ok(state));
        expect(await new RpcSeenStore(client).claim('msg:1', 'tok-1', 60)).toBe(
          state
        );
      }
    );

    it.each<[string, unknown]>([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['upper case', 'NEW'],
      ['an unknown word', 'maybe'],
      ['true', true],
      ['a number', 1],
      ['an array', ['new']],
      ['an object', { state: 'new' }],
    ])('rejects the answer %s', async (_name, answer) => {
      const { client } = fakeClient(ok(answer));
      await expect(
        new RpcSeenStore(client).claim('msg:1', 'tok-1', 60)
      ).rejects.toThrow(/edge_replay_claim returned/);
    });
  });

  describe('confirm', () => {
    it('calls edge_replay_confirm with exactly the named arguments', async () => {
      const { client, rpc } = fakeClient(ok(true));
      await new RpcSeenStore(client).confirm('msg:1', 'tok-1', 86_400);
      expectOneCall(rpc, 'edge_replay_confirm', CONFIRM_ARGS);
    });

    it('maps the boolean answer; only a strict true confirms', async () => {
      for (const [answer, expected] of [
        [true, true],
        [false, false],
        [null, false],
        ['true', false],
        [1, false],
      ] as const) {
        const { client } = fakeClient(ok(answer));
        expect(
          await new RpcSeenStore(client).confirm('msg:1', 'tok-1', 86_400)
        ).toBe(expected);
      }
    });
  });

  describe('release', () => {
    it('calls edge_replay_release with exactly the named arguments', async () => {
      const { client, rpc } = fakeClient(ok(true));
      await new RpcSeenStore(client).release('msg:1', 'tok-1');
      expectOneCall(rpc, 'edge_replay_release', RELEASE_ARGS);
    });

    it('never sends p_now (the function has no such parameter), even on the caller clock', async () => {
      const { client, rpc } = fakeClient(ok(true));
      await new RpcSeenStore(client, {
        useCallerClock: true,
        clock: () => T0,
      }).release('msg:1', 'tok-1');
      expectOneCall(rpc, 'edge_replay_release', RELEASE_ARGS);
    });

    it('maps the boolean answer; only a strict true releases', async () => {
      for (const [answer, expected] of [
        [true, true],
        [false, false],
        [null, false],
      ] as const) {
        const { client } = fakeClient(ok(answer));
        expect(await new RpcSeenStore(client).release('msg:1', 'tok-1')).toBe(
          expected
        );
      }
    });
  });

  describe('p_now is sent (claim, confirm) only when built with useCallerClock: true', () => {
    const cases: Array<{
      name: string;
      opts: ConstructorParameters<typeof RpcSeenStore>[1];
      pNow: string | undefined;
    }> = [
      {
        name: 'useCallerClock: true + clock → p_now is the clock’s time',
        opts: { useCallerClock: true, clock: () => T0 },
        pNow: T0_ISO,
      },
      {
        name: 'a clock without useCallerClock is ignored',
        opts: { clock: () => T0 },
        pNow: undefined,
      },
      {
        name: 'useCallerClock: false + clock → no p_now',
        opts: { useCallerClock: false, clock: () => T0 },
        pNow: undefined,
      },
      { name: 'empty options → no p_now', opts: {}, pNow: undefined },
      { name: 'no options → no p_now', opts: undefined, pNow: undefined },
    ];

    it.each(cases)('$name', async ({ opts, pNow }) => {
      const { client, rpc } = fakeClient(ok('new'));
      const store = new RpcSeenStore(client, opts);
      await store.claim('msg:1', 'tok-1', 60);
      await store.confirm('msg:1', 'tok-1', 86_400);
      expect(rpc.mock.calls).toStrictEqual([
        ['edge_replay_claim', { ...CLAIM_ARGS, ...withNow(pNow) }],
        ['edge_replay_confirm', { ...CONFIRM_ARGS, ...withNow(pNow) }],
      ]);
    });

    it('useCallerClock: true without a clock sends Date.now()', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(T0);
      const { client, rpc } = fakeClient(ok('new'));
      await new RpcSeenStore(client, { useCallerClock: true }).claim(
        'msg:1',
        'tok-1',
        60
      );
      expectOneCall(rpc, 'edge_replay_claim', { ...CLAIM_ARGS, p_now: T0_ISO });
    });
  });

  describe('failures propagate (the caller decides the policy)', () => {
    const calls = {
      edge_replay_claim: (s: RpcSeenStore) => s.claim('msg:1', 'tok-1', 60),
      edge_replay_confirm: (s: RpcSeenStore) =>
        s.confirm('msg:1', 'tok-1', 86_400),
      edge_replay_release: (s: RpcSeenStore) => s.release('msg:1', 'tok-1'),
    };

    it.each(Object.entries(calls))(
      '%s: an RPC error is thrown, naming the function',
      async (fn, call) => {
        const { client } = fakeClient(rpcError('db down'));
        await expect(call(new RpcSeenStore(client))).rejects.toThrow(
          `${fn} failed: db down`
        );
      }
    );

    it.each(Object.entries(calls))(
      '%s: a thrown transport error is not swallowed',
      async (_fn, call) => {
        const { client } = fakeClient(() => {
          throw new Error('socket hang up');
        });
        await expect(call(new RpcSeenStore(client))).rejects.toThrow(
          'socket hang up'
        );
      }
    );
  });

  it('ReplayGuard hands its generated token to the database and back on "new"', async () => {
    const claimed = fakeClient(ok('new'));
    const guard = new ReplayGuard(new RpcSeenStore(claimed.client));
    const claim = await guard.claim('msg:1');
    expect(claim).toStrictEqual({ state: 'new', token: expect.any(String) });
    await guard.confirm('msg:1', claim.token!);
    await guard.release('msg:1', claim.token!);
    expect(claimed.rpc.mock.calls).toStrictEqual([
      [
        'edge_replay_claim',
        { p_key: 'msg:1', p_token: claim.token, p_lease_seconds: 60 },
      ],
      [
        'edge_replay_confirm',
        { p_key: 'msg:1', p_token: claim.token, p_ttl_seconds: 86_400 },
      ],
      ['edge_replay_release', { p_key: 'msg:1', p_token: claim.token }],
    ]);

    const busy = fakeClient(ok('inflight'));
    expect(
      await new ReplayGuard(new RpcSeenStore(busy.client)).claim('msg:1')
    ).toStrictEqual({ state: 'inflight' });
  });
});

// ---------------------------------------------------------------------
// RpcLockoutStore → edge_auth_fail / _success / _lock_state
// ---------------------------------------------------------------------

describe('RpcLockoutStore', () => {
  // Distinct numbers, so a swapped mapping (ipMax ↔ userMax, …) shows up.
  const CFG: LockoutConfig = {
    ipMax: 7,
    userMax: 3,
    windowMs: 1234,
    lockMs: 5678,
  };
  const PAIR = { p_ip: '203.0.113.9', p_user_key: 'bob' };
  const FAIL_ARGS = {
    ...PAIR,
    p_ip_max: 7,
    p_user_max: 3,
    p_window_ms: 1234,
    p_lock_ms: 5678,
  };
  const ROW = { locked: false, retry_after_ms: 0 };
  const fail = (store: RpcLockoutStore, now?: number) =>
    store.fail('203.0.113.9', 'bob', now, CFG);
  const state = (store: RpcLockoutStore, now?: number) =>
    store.state('203.0.113.9', 'bob', now);

  it('fail: calls edge_auth_fail with exactly the named arguments', async () => {
    const { client, rpc } = fakeClient(ok([ROW]));
    await fail(new RpcLockoutStore(client));
    expectOneCall(rpc, 'edge_auth_fail', FAIL_ARGS);
  });

  it('state: calls edge_auth_lock_state with exactly the named arguments', async () => {
    const { client, rpc } = fakeClient(ok([ROW]));
    await state(new RpcLockoutStore(client));
    expectOneCall(rpc, 'edge_auth_lock_state', PAIR);
  });

  it('clear: calls edge_auth_success with exactly the named arguments and resolves to nothing', async () => {
    const { client, rpc } = fakeClient(ok(null));
    await expect(
      new RpcLockoutStore(client).clear('203.0.113.9', 'bob')
    ).resolves.toBeUndefined();
    expectOneCall(rpc, 'edge_auth_success', PAIR);
  });

  it('clear never sends p_now (the function has no such parameter), even on the caller clock', async () => {
    const { client, rpc } = fakeClient(ok(null));
    await new RpcLockoutStore(client, { useCallerClock: true }).clear(
      '203.0.113.9',
      'bob'
    );
    expectOneCall(rpc, 'edge_auth_success', PAIR);
  });

  describe('p_now is sent only when built with useCallerClock: true', () => {
    it.each(NOW_CASES)('fail — $name', async ({ opts, now, pNow }) => {
      const { client, rpc } = fakeClient(ok([ROW]));
      await fail(new RpcLockoutStore(client, opts), now);
      expectOneCall(rpc, 'edge_auth_fail', { ...FAIL_ARGS, ...withNow(pNow) });
    });

    it.each(NOW_CASES)('state — $name', async ({ opts, now, pNow }) => {
      const { client, rpc } = fakeClient(ok([ROW]));
      await state(new RpcLockoutStore(client, opts), now);
      expectOneCall(rpc, 'edge_auth_lock_state', {
        ...PAIR,
        ...withNow(pNow),
      });
    });
  });

  describe.each([
    {
      method: 'fail',
      fn: 'edge_auth_fail',
      call: (s: RpcLockoutStore) => fail(s),
    },
    {
      method: 'state',
      fn: 'edge_auth_lock_state',
      call: (s: RpcLockoutStore) => state(s),
    },
  ])('$method ($fn): the answer', ({ fn, call }) => {
    it.each(shapes({ locked: true, retry_after_ms: 840_000 }))(
      'maps a locked row sent as $shape',
      async ({ data }) => {
        const { client } = fakeClient(ok(data));
        expect(await call(new RpcLockoutStore(client))).toStrictEqual({
          locked: true,
          retryAfterMs: 840_000,
        });
      }
    );

    it.each(shapes({ locked: false, retry_after_ms: 0 }))(
      'maps an unlocked row sent as $shape',
      async ({ data }) => {
        const { client } = fakeClient(ok(data));
        expect(await call(new RpcLockoutStore(client))).toStrictEqual({
          locked: false,
          retryAfterMs: 0,
        });
      }
    );

    it('reports retryAfterMs 0 for an unlocked row even if the row carries a value', async () => {
      const { client } = fakeClient(
        ok([{ locked: false, retry_after_ms: 777 }])
      );
      expect(await call(new RpcLockoutStore(client))).toStrictEqual({
        locked: false,
        retryAfterMs: 0,
      });
    });

    it.each(NO_ROW)('throws when the answer is %s', async (_name, data) => {
      const { client } = fakeClient(ok(data));
      await expect(call(new RpcLockoutStore(client))).rejects.toThrow(
        `${fn} returned no row`
      );
    });

    it.each<[string, unknown]>([
      ['an empty object', {}],
      ['locked as a string', { locked: 'true', retry_after_ms: 0 }],
      ['retry_after_ms as a string', { locked: true, retry_after_ms: '5' }],
      ['retry_after_ms null', { locked: true, retry_after_ms: null }],
      ['retry_after_ms missing', { locked: true }],
      ['locked missing', { retry_after_ms: 0 }],
    ])('throws on a malformed row: %s', async (_name, row) => {
      const { client } = fakeClient(ok([row]));
      await expect(call(new RpcLockoutStore(client))).rejects.toThrow(
        `${fn} returned a malformed row`
      );
    });

    it('turns an RPC error into a thrown Error naming the function', async () => {
      const { client } = fakeClient(rpcError('db down'));
      await expect(call(new RpcLockoutStore(client))).rejects.toThrow(
        `${fn} failed: db down`
      );
    });

    it('does not swallow a thrown transport error', async () => {
      const { client } = fakeClient(() => {
        throw new Error('socket hang up');
      });
      await expect(call(new RpcLockoutStore(client))).rejects.toThrow(
        'socket hang up'
      );
    });
  });

  it('clear: an RPC error is thrown, naming the function', async () => {
    const { client } = fakeClient(rpcError('db down'));
    await expect(
      new RpcLockoutStore(client).clear('203.0.113.9', 'bob')
    ).rejects.toThrow('edge_auth_success failed: db down');
  });
});

// ---------------------------------------------------------------------
// guardAdmin over the RPC stores
// ---------------------------------------------------------------------

describe('guardAdmin over the RPC stores', () => {
  const HAPPY: Record<string, Answer> = {
    edge_auth_lock_state: ok([{ locked: false, retry_after_ms: 0 }]),
    edge_rate_check: ok([{ allowed: true, remaining: 9, retry_after_ms: 0 }]),
    edge_auth_fail: ok([{ locked: false, retry_after_ms: 0 }]),
    edge_auth_success: ok(null),
  };

  function harness(overrides: Record<string, Answer> = {}) {
    const answers = { ...HAPPY, ...overrides };
    const { client, rpc } = fakeClient((name) => {
      const answer = answers[name];
      if (!answer) throw new Error(`unexpected rpc ${name}`);
      return answer;
    });
    const log = { warn: vi.fn() };
    const ctx: AdminCtx = {
      lockout: new AuthLockout(new RpcLockoutStore(client)),
      limiter: new RateLimiter(new RpcRateStore(client), DEFAULT_SCOPES, log),
    };
    return { ctx, rpc, log };
  }
  const names = (rpc: FakeRpc) => rpc.mock.calls.map(([name]) => name);

  it('good credentials: the whole call sequence, with the database clock even if now is given', async () => {
    const { ctx, rpc } = harness();
    expect(
      await guardAdmin(
        ctx,
        { ip: '::ffff:203.0.113.9', userId: 'Bob', authOk: true },
        T0
      )
    ).toEqual({ allowed: true, status: 200 });
    expect(rpc.mock.calls).toStrictEqual([
      ['edge_auth_lock_state', { p_ip: '203.0.113.9', p_user_key: 'bob' }],
      [
        'edge_rate_check',
        {
          p_scope: 'admin.ip',
          p_key: '203.0.113.9',
          p_limit: 10,
          p_window_ms: 1000,
        },
      ],
      [
        'edge_rate_check',
        { p_scope: 'admin.user', p_key: 'bob', p_limit: 30, p_window_ms: 1000 },
      ],
      ['edge_auth_success', { p_ip: '203.0.113.9', p_user_key: 'bob' }],
    ]);
  });

  it('bad credentials: 401, and the failure is logged with the default lockout limits', async () => {
    const { ctx, rpc } = harness();
    expect(await guardAdmin(ctx, { ip: '203.0.113.9', authOk: false })).toEqual(
      { allowed: false, status: 401 }
    );
    // No user id → user "" (never null/undefined: p_user_key is a text key).
    expect(rpc.mock.calls.at(-1)).toStrictEqual([
      'edge_auth_fail',
      {
        p_ip: '203.0.113.9',
        p_user_key: '',
        p_ip_max: 20,
        p_user_max: 5,
        p_window_ms: 600_000,
        p_lock_ms: 900_000,
      },
    ]);
  });

  it('a lock reported by the database answers 423 with its retry hint and stops there', async () => {
    const { ctx, rpc } = harness({
      edge_auth_lock_state: ok([{ locked: true, retry_after_ms: 840_000 }]),
    });
    expect(
      await guardAdmin(ctx, { ip: '203.0.113.9', userId: 'bob', authOk: true })
    ).toEqual({ allowed: false, status: 423, retryAfterMs: 840_000 });
    expect(names(rpc)).toEqual(['edge_auth_lock_state']);
  });

  describe.each([
    {
      step: 'edge_auth_lock_state (the first check)',
      fn: 'edge_auth_lock_state',
      authOk: true,
    },
    {
      step: 'edge_auth_fail (recording a bad login)',
      fn: 'edge_auth_fail',
      authOk: false,
    },
    {
      step: 'edge_auth_success (clearing after a good login)',
      fn: 'edge_auth_success',
      authOk: true,
    },
  ])('a lockout store error at $step', ({ fn, authOk }) => {
    const req = { ip: '203.0.113.9', userId: 'bob', authOk };

    it('propagates (the host answers 500) instead of being skipped', async () => {
      const { ctx, log } = harness({ [fn]: rpcError('db down') });
      await expect(guardAdmin(ctx, req)).rejects.toThrow(
        `${fn} failed: db down`
      );
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('also propagates when the call itself throws', async () => {
      const base = harness();
      const { client } = fakeClient((name) => {
        if (name === fn) throw new Error('socket hang up');
        return HAPPY[name];
      });
      const ctx: AdminCtx = {
        lockout: new AuthLockout(new RpcLockoutStore(client)),
        limiter: base.ctx.limiter,
      };
      await expect(guardAdmin(ctx, req)).rejects.toThrow('socket hang up');
    });
  });

  it('a rate-limit RPC error on the admin scope refuses with 429 and records no auth failure', async () => {
    const { ctx, rpc, log } = harness({ edge_rate_check: rpcError('db down') });
    expect(
      await guardAdmin(ctx, { ip: '203.0.113.9', userId: 'bob', authOk: false })
    ).toEqual({ allowed: false, status: 429, retryAfterMs: 1000 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(names(rpc)).toEqual(['edge_auth_lock_state', 'edge_rate_check']);
  });
});
