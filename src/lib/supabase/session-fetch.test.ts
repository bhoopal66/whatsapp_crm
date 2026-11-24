import { createClient as createSupabase } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const made = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => object>(() => ({ auth: {} }))
);
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: made,
  createServerClient: made,
}));
const jar = vi.hoisted(() => ({ has: vi.fn((_name: string) => false) }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));

import { createClient as createBrowser } from './client';
import { createClient as createServer } from './server';
import {
  createServerRefresh,
  createSessionFetch,
  REFRESH_UNANSWERED_COOKIE,
} from './session-fetch';

const REFRESH = 'http://sb.test/auth/v1/token?grant_type=refresh_token';
const json = (status: number) => () =>
  Response.json({ code: status, error_code: 'x', msg: 'x' }, { status });
const page = (status: number) => () =>
  new Response('<html>Just a moment…</html>', { status });
const answer =
  vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>();

beforeEach(() => {
  answer.mockReset();
  jar.has.mockReturnValue(false);
  vi.stubGlobal('fetch', answer);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createSessionFetch', () => {
  it.each<[string, string, () => Response, number]>([
    ['a throttled refresh', REFRESH, json(429), 503],
    ['a challenge page for a refresh', REFRESH, page(403), 503],
    [
      'an empty refusal',
      REFRESH,
      () => new Response(null, { status: 400 }),
      503,
    ],
    ['a refused refresh', REFRESH, json(400), 400],
    ['a refresh', REFRESH, json(200), 200],
    ['an outage', REFRESH, page(502), 502],
    [
      'a throttled sign-in',
      'http://sb.test/auth/v1/token?grant_type=password',
      json(429),
      429,
    ],
    ['another page', 'http://sb.test/rest/v1/contacts', page(403), 403],
    ['a throttled user read', 'http://sb.test/auth/v1/user', json(429), 429],
  ])('%s', async (_what, url, response, status) => {
    const sent = response();
    answer.mockImplementation(async () => sent);
    const init = { method: 'POST' };
    const got = await createSessionFetch()(url, init);
    expect(got.status).toBe(status);
    expect(answer).toHaveBeenCalledWith(url, init);
    if (status === sent.status) {
      expect(got).toBe(sent);
      // Still the caller's to read.
      expect(await got.text()).not.toBe('');
    }
  });

  it('passes a failure on', async () => {
    answer.mockRejectedValue(new TypeError('offline'));
    await expect(createSessionFetch()(REFRESH)).rejects.toThrow('offline');
  });

  it.each([
    [null, 5],
    ['12', 12],
    ['600', 30],
    ['0', 5],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 5],
  ])('after Retry-After %s, asks again in %i s', async (retryAfter, s) => {
    vi.useFakeTimers();
    answer.mockImplementation(async () => {
      const res = json(429)();
      if (retryAfter) res.headers.set('retry-after', retryAfter);
      return res;
    });
    const ask = createSessionFetch();
    await ask(REFRESH);
    vi.advanceTimersByTime(s * 1000 - 1);
    expect((await ask(REFRESH)).status).toBe(503);
    expect(answer).toHaveBeenCalledTimes(1);
    // Only the refresh waits, and only this client's.
    await ask('http://sb.test/auth/v1/token?grant_type=password');
    expect(answer).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await ask(REFRESH);
    expect(answer).toHaveBeenCalledTimes(3);
    await createSessionFetch()(REFRESH);
    expect(answer).toHaveBeenCalledTimes(4);
  });

  it('does not pause for an outage', async () => {
    answer.mockImplementation(async () => page(502)());
    const ask = createSessionFetch();
    await ask(REFRESH);
    await ask(REFRESH);
    expect(answer).toHaveBeenCalledTimes(2);
  });
});

/** `expiresIn`: the access token's, in seconds. */
async function refresh(
  response: () => Response | Promise<Response>,
  server: Parameters<typeof createServerRefresh> | null = null,
  expiresIn = -60
) {
  vi.useFakeTimers();
  answer.mockImplementation(async () => response());
  const bounded = server && createServerRefresh(...server);
  const store = new Map([
    [
      'k',
      JSON.stringify({
        access_token: 'a.b.c',
        refresh_token: 'r',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        user: { id: 'u1' },
      }),
    ],
  ]);
  const events: string[] = [];
  const supabase = createSupabase('http://sb.test', 'anon', {
    auth: {
      storageKey: 'k',
      autoRefreshToken: false,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    },
    global: { fetch: bounded?.fetch ?? createSessionFetch() },
  });
  bounded?.bound(supabase);
  const { auth } = supabase;
  auth.onAuthStateChange((event) => void events.push(event));
  const startedAt = Date.now();
  const asked = auth.getSession().then(({ data, error }) => ({
    seconds: (Date.now() - startedAt) / 1000,
    requests: answer.mock.calls.length,
    token: data.session?.access_token,
    error: error?.name,
  }));
  await vi.advanceTimersByTimeAsync(40_000);
  return {
    ...(await asked),
    // Those sent after the answer included.
    requestsInAll: answer.mock.calls.length,
    kept: store.get('k')?.includes('"r"') ?? false,
    signedOut: events.includes('SIGNED_OUT'),
  };
}

describe('the real auth-js over it', () => {
  it.each([
    ['throttled', json(429)],
    ['challenged', page(403)],
  ])('keeps the session when %s', async (_what, response) => {
    const got = await refresh(response);
    expect(got).toMatchObject({ kept: true, signedOut: false });
    // At 0, 6.2, 12.6 and 25.4 s: not one per retry (8).
    expect(got.requestsInAll).toBe(4);
  });

  it('ends it when the auth service refuses', async () => {
    expect(await refresh(json(400))).toMatchObject({
      kept: false,
      signedOut: true,
    });
  });
});

describe('the real auth-js on the server', () => {
  const unanswered = {
    error: 'AuthRetryableFetchError',
    kept: true,
    signedOut: false,
  };

  it.each<[string, () => Response | Promise<Response>, number, number]>([
    // [answer, requests, seconds]; unbounded, all are 25.4 s or more.
    ['throttled', json(429), 1, 0],
    ['challenged', page(403), 1, 0],
    ['an outage', json(503), 4, 3],
    ['a failing gateway', page(502), 4, 3],
    ['no connection', () => Promise.reject(new TypeError('refused')), 4, 3],
    ['no answer', () => new Promise<Response>(() => {}), 1, 3],
  ])('%s', async (_what, response, requests, seconds) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await refresh(response, [])).toEqual({
      ...unanswered,
      seconds,
      requests,
      requestsInAll: requests,
      token: undefined,
    });
    vi.restoreAllMocks();
  });

  it('an answer whose body never ends', async () => {
    const stalled = () => new Response(new ReadableStream(), { status: 200 });
    expect(await refresh(stalled, [])).toMatchObject({
      ...unanswered,
      seconds: 3,
      requestsInAll: 1,
    });
  });

  it('gives up a request that is under way', async () => {
    let signal: AbortSignal | null | undefined;
    await refresh(() => {
      signal = answer.mock.calls[0][1]?.signal;
      return new Promise<Response>(() => {});
    }, []);
    expect(signal?.aborted).toBe(true);
  });

  it('asks again inside the wait when the throttle is that short', async () => {
    const brief = () => {
      const res = json(429)();
      res.headers.set('retry-after', '1');
      return res;
    };
    // At 0 and 1.4 s.
    expect(await refresh(brief, [])).toMatchObject({
      ...unanswered,
      seconds: 3,
      requestsInAll: 2,
    });
  });

  it('does not ask where the middleware already got no answer', async () => {
    expect(await refresh(json(200), [() => true])).toMatchObject({
      ...unanswered,
      seconds: 0,
      requestsInAll: 0,
    });
  });

  it('still uses a token that is about to expire', async () => {
    expect(await refresh(json(429), [], 30)).toMatchObject({
      error: undefined,
      token: 'a.b.c',
      seconds: 0,
      requestsInAll: 1,
      kept: true,
    });
  });

  it('takes an answer that comes within the wait', async () => {
    const rotated = () => {
      if (answer.mock.calls.length < 3) return json(503)();
      return Response.json({
        access_token: 'd.e.f',
        refresh_token: 'r2',
        token_type: 'bearer',
        expires_in: 3600,
        user: { id: 'u1' },
      });
    };
    expect(await refresh(rotated, [])).toMatchObject({
      error: undefined,
      token: 'd.e.f',
      requestsInAll: 3,
    });
  });

  it('ends the session when the auth service refuses', async () => {
    expect(await refresh(json(400), [])).toMatchObject({
      error: 'AuthApiError',
      kept: false,
      signedOut: true,
      seconds: 0,
    });
  });
});

describe('the clients that hold a session', () => {
  it.each([
    ['browser', createBrowser],
    ['server', createServer],
  ])('%s', async (_which, create) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://sb.test');
    await create();
    const { global } = made.mock.calls.at(-1)?.[2] as {
      global: { fetch: typeof fetch };
    };
    answer.mockImplementation(async () => json(429)());
    expect((await global.fetch(REFRESH)).status).toBe(503);
    expect((await global.fetch(REFRESH)).status).toBe(503);
    expect(answer).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('server: bounds its refresh, and heeds the middleware', async () => {
    const auth = { _refreshAccessToken: () => new Promise(() => {}) };
    made.mockReturnValueOnce({ auth });
    jar.has.mockImplementation((name) => name === REFRESH_UNANSWERED_COOKIE);
    await createServer();
    const { global } = made.mock.calls.at(-1)?.[2] as {
      global: { fetch: typeof fetch };
    };
    const refreshed = auth._refreshAccessToken();
    expect((await global.fetch(REFRESH)).status).toBe(503);
    expect(answer).not.toHaveBeenCalled();
    expect(await refreshed).toMatchObject({
      error: { name: 'AuthRetryableFetchError' },
    });
  });
});
