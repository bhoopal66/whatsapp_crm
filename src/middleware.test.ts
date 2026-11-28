import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let mockError: { name: string; status: number } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    }
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser }, error: mockError };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import('./middleware');

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  mockUser = null;
  mockError = null;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: 'sb-test-auth-token',
  value: 'rotated-refresh-token',
  options: { path: '/', httpOnly: true },
};

describe('middleware — refreshed auth cookies survive redirects', () => {
  it('carries the rotated token when redirecting a signed-in user off /login', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest('https://app.test/login'));

    // Redirect to the landing redirect at `/` (it picks the role's page)…
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/');
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it('carries the rotated token when redirecting an unauth user to /login', async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: 'cleared' }];

    const res = await middleware(new NextRequest('https://app.test/dashboard'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.cookies.get(ROTATED.name)?.value).toBe('cleared');
  });

  it('redirects a signed-in user with an invite token to /join/<token>', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest('https://app.test/login?invite=abc123')
    );

    expect(res.headers.get('location')).toContain('/join/abc123');
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it('sends a signed-in user on /login?next= to that same-origin path', async () => {
    mockUser = { id: 'user-1' };
    const res = await middleware(
      new NextRequest('https://app.test/login?next=%2Fcases%3Fstage%3Dx')
    );
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe('https://app.test');
    expect(loc.pathname + loc.search).toBe('/cases?stage=x');
  });

  it('ignores an off-origin next on /login', async () => {
    mockUser = { id: 'user-1' };
    const res = await middleware(
      new NextRequest('https://app.test/login?next=%2F%2Fevil.example%2Fx')
    );
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe('https://app.test');
    expect(loc.pathname).toBe('/');
  });

  it('keeps the deep link in next when sending a logged-out visitor to /login', async () => {
    mockUser = null;
    const res = await middleware(
      new NextRequest('https://app.test/cases/abc?tab=files')
    );
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe('/cases/abc?tab=files');
  });

  it('passes through (no redirect) for a signed-in user on a protected page', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest('https://app.test/dashboard'));

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe('middleware — every dashboard screen is gated', () => {
  // Derived from the filesystem so a new screen under (dashboard) fails
  // this test until it is added to `protectedPaths` — the list drifted
  // once already (/flows, /agents, /notifications, /team-*).
  const dashboardDir = path.join(process.cwd(), 'src/app/(dashboard)');
  const screens = fs
    .readdirSync(dashboardDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `/${d.name}`);

  it.each(screens)('redirects a logged-out visitor on %s', async (screen) => {
    mockUser = null;
    const res = await middleware(new NextRequest(`https://app.test${screen}`));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('middleware — /api/whatsapp session gate', () => {
  it('401s a logged-out caller on an ordinary WhatsApp API route', async () => {
    const res = await middleware(
      new NextRequest('https://app.test/api/whatsapp/broadcast')
    );
    expect(res.status).toBe(401);
  });

  it('lets the broadcast cron through to authenticate with its own secret', async () => {
    // Pinged by a scheduler, never by a browser — the route checks
    // x-cron-secret itself, like /api/automations/cron.
    const res = await middleware(
      new NextRequest('https://app.test/api/whatsapp/broadcast/cron')
    );
    expect(res.status).toBe(200);
  });

  it('lets the inbound webhooks through', async () => {
    const res = await middleware(
      new NextRequest('https://app.test/api/whatsapp/meta/webhook')
    );
    expect(res.status).toBe(200);
  });
});

describe('middleware — the auth service does not answer', () => {
  const BLIP = { name: 'AuthRetryableFetchError', status: 0 };
  const request = (url: string, cookie = 'sb-wacrm-auth-token=base64-x') =>
    new NextRequest(`https://app.test${url}`, { headers: { cookie } });

  it('lets a page through for someone holding a session cookie', async () => {
    mockError = BLIP;
    const chunked = 'sb-wacrm-auth-token.0=base64-x';
    for (const res of [
      await middleware(request('/inbox')),
      await middleware(request('/inbox', chunked)),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('answers the gated API 503, not 401', async () => {
    mockError = BLIP;
    const res = await middleware(request('/api/whatsapp/broadcast'));
    expect(res.status).toBe(503);
    expect(typeof (await res.json()).error).toBe('string');
  });

  it('still redirects without a session cookie', async () => {
    mockError = BLIP;
    const other = 'sb-wacrm-auth-token-code-verifier=x';
    const res = await middleware(request('/inbox', other));
    expect(res.headers.get('location')).toContain('/login');
    const api = await middleware(request('/api/whatsapp/broadcast', other));
    expect(api.status).toBe(401);
  });

  it('still redirects on a real refusal, cookie or not', async () => {
    for (const status of [400, 401, 403]) {
      mockError = { name: 'AuthApiError', status };
      const res = await middleware(request('/inbox'));
      expect(res.headers.get('location')).toContain('/login');
      const api = await middleware(request('/api/whatsapp/broadcast'));
      expect(api.status).toBe(401);
    }
  });
});

describe('middleware — the session cookie', () => {
  it('is capped at the idle limit, unchanged chunks included', async () => {
    mockUser = { id: 'u1' };
    refreshedCookies = [
      {
        name: 'sb-wacrm-auth-token.0',
        value: 'head',
        options: { path: '/', maxAge: 400 * 86_400 },
      },
    ];
    const res = await middleware(
      new NextRequest('https://app.test/inbox', {
        headers: {
          cookie: 'sb-wacrm-auth-token.0=old; sb-wacrm-auth-token.1=tail',
        },
      })
    );
    expect(
      res.cookies.getAll().map((c) => [c.name, c.value, c.maxAge])
    ).toEqual([
      ['sb-wacrm-auth-token.0', 'head', 604800],
      ['sb-wacrm-auth-token.1', 'tail', 604800],
    ]);
  });
});

describe('middleware — cross-site writes', () => {
  const post = (url: string, headers: Record<string, string>) =>
    middleware(
      new NextRequest(`https://app.test${url}`, { method: 'POST', headers })
    );

  it('refuses one a browser marks as cross-site, before any session work', async () => {
    mockUser = { id: 'u1' };
    refreshedCookies = [ROTATED];
    const res = await post('/api/account/members', {
      'sec-fetch-site': 'same-site',
    });
    expect(res.status).toBe(403);
    expect(res.cookies.getAll()).toEqual([]);
  });

  it('lets the app, a webhook, the web form and API keys through', async () => {
    mockUser = { id: 'u1' };
    for (const [url, headers] of [
      ['/api/account/members', { 'sec-fetch-site': 'same-origin' }],
      ['/api/whatsapp/webhook', {}],
      ['/api/public/web-form/t', { 'sec-fetch-site': 'cross-site' }],
      ['/api/v1/messages', { 'sec-fetch-site': 'cross-site' }],
    ] as Array<[string, Record<string, string>]>) {
      const res = await post(url, headers);
      expect(res.status, url).not.toBe(403);
    }
  });
});

describe('middleware — the Content-Security-Policy', () => {
  const nonceOf = (csp: string | null) =>
    csp?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];

  it('enforces a policy whose nonce the page render receives', async () => {
    mockUser = { id: 'user-1' };
    const res = await middleware(new NextRequest('https://app.test/inbox'));
    const csp = res.headers.get('content-security-policy');
    const nonce = nonceOf(csp);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    // Forwarded to the render: Next.js reads the request's CSP header, the
    // root layout reads x-nonce.
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(
      res.headers.get('x-middleware-request-content-security-policy')
    ).toBe(csp);
  });

  it('uses a new nonce per request and overwrites a client-sent one', async () => {
    const req = new NextRequest('https://app.test/login', {
      headers: {
        'x-nonce': 'attacker',
        'content-security-policy': "script-src 'nonce-attackerattacker1234'",
      },
    });
    const a = await middleware(req);
    const b = await middleware(new NextRequest('https://app.test/login'));
    const na = nonceOf(a.headers.get('content-security-policy'));
    expect(na).toBeTruthy();
    expect(na).not.toBe(nonceOf(b.headers.get('content-security-policy')));
    expect(a.headers.get('x-middleware-request-x-nonce')).toBe(na);
    expect(
      a.headers.get('x-middleware-request-content-security-policy')
    ).not.toContain('attacker');
  });

  it('keeps the policy (and its nonce) when the session cookie rotates', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];
    const res = await middleware(new NextRequest('https://app.test/inbox'));
    const nonce = nonceOf(res.headers.get('content-security-policy'));
    expect(nonce).toBeTruthy();
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});
