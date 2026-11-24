import { createClient as createSupabase } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const made = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => object>(() => ({}))
);
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: made,
  createServerClient: made,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));

import { createClient as createBrowser } from './client';
import { createClient as createServer } from './server';
import { sessionFetch } from './session-fetch';

const REFRESH = 'http://sb.test/auth/v1/token?grant_type=refresh_token';
const json = (status: number) => () =>
  Response.json({ code: status, error_code: 'x', msg: 'x' }, { status });
const page = (status: number) => () =>
  new Response('<html>Just a moment…</html>', { status });
const answer =
  vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>();

beforeEach(() => void vi.stubGlobal('fetch', answer));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sessionFetch', () => {
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
    const got = await sessionFetch(url, init);
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
    await expect(sessionFetch(REFRESH)).rejects.toThrow('offline');
  });
});

describe('the real auth-js over it', () => {
  async function refresh(response: () => Response) {
    vi.useFakeTimers();
    answer.mockImplementation(async () => response());
    const store = new Map([
      [
        'k',
        JSON.stringify({
          access_token: 'a.b.c',
          refresh_token: 'r',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) - 60,
          user: { id: 'u1' },
        }),
      ],
    ]);
    const events: string[] = [];
    const { auth } = createSupabase('http://sb.test', 'anon', {
      auth: {
        storageKey: 'k',
        autoRefreshToken: false,
        storage: {
          getItem: (k) => store.get(k) ?? null,
          setItem: (k, v) => void store.set(k, v),
          removeItem: (k) => void store.delete(k),
        },
      },
      global: { fetch: sessionFetch },
    });
    auth.onAuthStateChange((event) => void events.push(event));
    const asked = auth.getSession();
    await vi.advanceTimersByTimeAsync(40_000);
    await asked;
    return { kept: store.has('k'), signedOut: events.includes('SIGNED_OUT') };
  }

  it.each([
    ['throttled', json(429)],
    ['challenged', page(403)],
  ])('keeps the session when %s', async (_what, response) => {
    expect(await refresh(response)).toEqual({ kept: true, signedOut: false });
  });

  it('ends it when the auth service refuses', async () => {
    expect(await refresh(json(400))).toEqual({ kept: false, signedOut: true });
  });
});

describe('the clients that hold a session', () => {
  it.each([
    ['browser', createBrowser],
    ['server', createServer],
  ])('%s', async (_which, create) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://sb.test');
    await create();
    expect(made.mock.calls.at(-1)?.[2]).toMatchObject({
      global: { fetch: sessionFetch },
    });
    vi.unstubAllEnvs();
  });
});
