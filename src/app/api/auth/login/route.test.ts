import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AuthLockout,
  DEFAULT_SCOPES,
  MemoryLockoutStore,
  MemoryRateStore,
  RateLimiter,
  type AdminCtx,
  type LockoutStore,
} from '@/lib/edge';

// The real lockout and rate limiter over memory stores (fresh per test);
// only GoTrue and the Postgres-backed stores are replaced.
const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  guards: null as unknown as AdminCtx,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signInWithPassword: mocks.signIn } }),
}));
vi.mock('@/lib/auth/edge-guards', () => ({
  edgeAuthGuards: () => mocks.guards,
}));

import { POST } from './route';

const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const PASSWORD = 'correct horse';
const OK = { data: { user: { id: 'u1' }, session: {} }, error: null };
const apiError = (
  status: number,
  code: string,
  message = 'GoTrue says no'
) => ({
  data: { user: null, session: null },
  error: { name: 'AuthApiError', status, code, message },
});
const BAD = apiError(400, 'invalid_credentials', 'Invalid login credentials');

let store: LockoutStore;

function useStore(s: LockoutStore) {
  store = s;
  mocks.guards = {
    lockout: new AuthLockout(s),
    limiter: new RateLimiter(new MemoryRateStore(), DEFAULT_SCOPES, {
      warn: vi.fn(),
    }),
  };
}

// The real signInWithPassword answers per password; the mock does too.
function answer(result: unknown = BAD) {
  mocks.signIn.mockImplementation(async ({ password }: { password: string }) =>
    password === PASSWORD ? OK : result
  );
}

/** One attempt; the clock then moves 150 ms, under the 10/s IP limit. */
async function login(
  email: string,
  password = 'wrong',
  ip: string | null = '203.0.113.7',
  spaced = true
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (ip) headers['cf-connecting-ip'] = ip;
  const res = await POST(
    new Request('https://crm.example.com/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    })
  );
  if (spaced) vi.setSystemTime(Date.now() + 150);
  return res;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('EDGE_CLIENT_IP_HEADER', 'cf-connecting-ip');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.signIn.mockReset();
  answer();
  const memory = new MemoryLockoutStore();
  vi.spyOn(memory, 'fail');
  vi.spyOn(memory, 'clear');
  useStore(memory);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/auth/login', () => {
  it('signs in through the SSR client with the trimmed email', async () => {
    const res = await login('  alice@example.com ', PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.signIn).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: PASSWORD,
    });
    expect(store.clear).toHaveBeenCalledWith(
      '203.0.113.7',
      'alice@example.com'
    );
  });

  it('answers every credential failure with one generic 401', async () => {
    answer(apiError(400, 'validation_failed', 'Unable to validate email'));
    const unknown = await login('nobody@example.com');
    answer(BAD);
    const wrong = await login('alice@example.com');
    for (const res of [unknown, wrong]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid email or password' });
    }
    expect(store.fail).toHaveBeenCalledTimes(2);
  });

  it('locks the pair on the fifth failure; a locked pair never reaches GoTrue', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login('alice@example.com')).status).toBe(401);
    }
    const res = await login('alice@example.com', PASSWORD);
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({
      error: 'Too many failed sign-in attempts. Try again later.',
      retryAfterSeconds: 900,
    });
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(mocks.signIn).toHaveBeenCalledTimes(5);
    // The lock is the pair's: the same email from another IP still works.
    expect(
      (await login('alice@example.com', PASSWORD, '198.51.100.9')).status
    ).toBe(200);
  });

  it('treats the email as one user whatever its case', async () => {
    for (const email of [
      'Alice@Example.com',
      'alice@example.com',
      'ALICE@example.COM',
      'alice@EXAMPLE.com',
      'Alice@example.com',
    ]) {
      expect((await login(email)).status).toBe(401);
    }
    expect((await login('alice@example.com', PASSWORD)).status).toBe(423);
  });

  it('a success clears the pair, so earlier failures do not add up to a lock', async () => {
    for (let i = 0; i < 4; i++) await login('alice@example.com');
    expect((await login('alice@example.com', PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await login('alice@example.com')).status).toBe(401);
    }
    expect((await login('alice@example.com', PASSWORD)).status).toBe(200);
  });

  it('with no client IP, buckets by email so one attacker cannot lock everyone out', async () => {
    vi.stubEnv('EDGE_CLIENT_IP_HEADER', '');
    // 20 failures — the per-IP limit — spread over four targets.
    for (const who of ['a', 'b', 'c', 'd']) {
      for (let i = 0; i < 5; i++) await login(`${who}@example.com`, 'x', null);
    }
    expect((await login('a@example.com', PASSWORD, null)).status).toBe(423);
    const bob = await login('bob@example.com', PASSWORD, null);
    expect(bob.status).toBe(200);
    expect(store.fail).toHaveBeenLastCalledWith(
      'unknown:d@example.com',
      'd@example.com',
      undefined,
      expect.anything()
    );
  });

  it('rate-limits by IP: the 11th attempt in a second is 429 and never reaches GoTrue', async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        (await login(`u${i}@example.com`, 'x', '203.0.113.7', false)).status
      ).toBe(401);
    }
    const res = await login('u10@example.com', PASSWORD, '203.0.113.7', false);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'Too many sign-in requests. Try again shortly.',
      retryAfterSeconds: 1,
    });
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(mocks.signIn).toHaveBeenCalledTimes(10);
    expect(store.fail).toHaveBeenCalledTimes(10);
  });

  it('rate-limits by user: the 31st attempt in a second for one email is 429', async () => {
    for (let i = 0; i < 30; i++) {
      expect(
        (await login('alice@example.com', 'x', `198.51.100.${i}`, false)).status
      ).toBe(401);
    }
    const res = await login(
      'alice@example.com',
      PASSWORD,
      '198.51.100.99',
      false
    );
    expect(res.status).toBe(429);
    expect(mocks.signIn).toHaveBeenCalledTimes(30);
  });

  it('fails closed when the lockout cannot be read: 503, GoTrue never called', async () => {
    const down = new MemoryLockoutStore();
    vi.spyOn(down, 'state').mockRejectedValue(new Error('db down'));
    useStore(down);
    const res = await login('alice@example.com', PASSWORD);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Sign-in is temporarily unavailable',
    });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('a failure that cannot be counted is 503; a success that cannot be cleared still signs in', async () => {
    const s = new MemoryLockoutStore();
    vi.spyOn(s, 'fail').mockRejectedValue(new Error('db down'));
    vi.spyOn(s, 'clear').mockRejectedValue(new Error('db down'));
    useStore(s);
    expect((await login('alice@example.com')).status).toBe(503);
    expect((await login('alice@example.com', PASSWORD)).status).toBe(200);
  });

  it('keeps the deactivated message for a banned member, and counts the attempt', async () => {
    answer(apiError(400, 'user_banned', 'User is banned'));
    const res = await login('gone@example.com', 'anything');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Your access has been deactivated. Contact your administrator.',
    });
    expect(store.fail).toHaveBeenCalledTimes(1);
  });

  it('does not count GoTrue throttling (429) or GoTrue being down (503)', async () => {
    answer(apiError(429, 'over_request_rate_limit'));
    expect((await login('alice@example.com')).status).toBe(429);
    for (const down of [
      { data: {}, error: { name: 'AuthRetryableFetchError', status: 0 } },
      apiError(500, 'unexpected_failure'),
      { data: {}, error: { name: 'AuthUnknownError', message: 'not JSON' } },
    ]) {
      answer(down);
      expect((await login('alice@example.com')).status).toBe(503);
    }
    mocks.signIn.mockRejectedValue(new Error('fetch failed'));
    expect((await login('alice@example.com')).status).toBe(503);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('refuses anything but JSON credentials before the lockout or GoTrue', async () => {
    const send = (body: string, type = 'application/json') =>
      POST(
        new Request('https://crm.example.com/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': type, 'cf-connecting-ip': '203.0.113.7' },
          body,
        })
      );
    const state = vi.spyOn(store, 'state');
    for (const res of await Promise.all([
      send(JSON.stringify({ email: 'alice@example.com' })),
      send(JSON.stringify({ email: '  ', password: 'x' })),
      send(JSON.stringify({ email: 'alice@example.com', password: 7 })),
      send('not json'),
      send(
        JSON.stringify({ email: 'alice@example.com', password: 'x' }),
        'text/plain'
      ),
    ])) {
      expect(res.status).toBe(400);
    }
    expect(state).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
});
