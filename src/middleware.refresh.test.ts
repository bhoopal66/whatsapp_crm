import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real auth-js behind the real middleware, an expired session in its
// cookie. What counts as no answer: lib/supabase/session-fetch.ts.
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({}),
}));

import { REFRESH_UNANSWERED_COOKIE } from '@/lib/supabase/session-fetch';
import { AUTH_COOKIE_NAME } from '@/lib/supabase/urls';
import { middleware } from './middleware';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://sb.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function open(response: () => Response) {
  const fetched = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetched);
  const session = JSON.stringify({
    access_token: 'a.b.c',
    refresh_token: 'r',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 60,
    user: { id: 'u1' },
  });
  const startedAt = Date.now();
  let seconds = -1;
  const pending = middleware(
    new NextRequest('https://app.test/inbox', {
      headers: {
        cookie: `${AUTH_COOKIE_NAME}=base64-${Buffer.from(session).toString('base64url')}`,
      },
    })
  ).then((res) => {
    seconds = (Date.now() - startedAt) / 1000;
    return res;
  });
  await vi.advanceTimersByTimeAsync(40_000);
  const res = await pending;
  return {
    to: res.headers.get('location'),
    cookies: res.cookies.getAll().length,
    seconds,
    // Those its retries sent after the answer included.
    requests: fetched.mock.calls.length,
    told: (res.headers.get('x-middleware-request-cookie') ?? '').includes(
      REFRESH_UNANSWERED_COOKIE
    ),
  };
}

describe('middleware — a token refresh that was not answered', () => {
  it.each<[string, () => Response, number, number]>([
    ['throttled', () => Response.json({ msg: 'x' }, { status: 429 }), 1, 0],
    ['challenged', () => new Response('<html></html>', { status: 403 }), 1, 0],
    ['down', () => Response.json({ msg: 'x' }, { status: 500 }), 4, 3],
  ])(
    'keeps the page and the session when %s',
    async (_what, response, requests, seconds) => {
      expect(await open(response)).toEqual({
        to: null,
        cookies: 0,
        requests,
        seconds,
        told: true,
      });
    }
  );

  it('ends the session when it was refused', async () => {
    const refused = () =>
      Response.json(
        { error_code: 'refresh_token_not_found', msg: 'x' },
        { status: 400 }
      );
    const { to, cookies, told } = await open(refused);
    expect(told).toBe(false);
    expect(to).toContain('/login');
    expect(cookies).toBeGreaterThan(0);
  });
});
