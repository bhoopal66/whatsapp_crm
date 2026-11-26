import { beforeEach, describe, expect, it, vi } from 'vitest';

// The three clients hand @supabase/ssr cookie methods that cap the
// session: without that, its 400 days come back without a word.
type Methods = {
  setAll: (c: Array<{ name: string; value: string; options: object }>) => void;
};
const h = vi.hoisted(() => ({
  server: [] as unknown[],
  browser: [] as unknown[],
  set: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_u: string, _k: string, o: unknown) => {
    h.server.push(o);
    return {};
  },
  createBrowserClient: (_u: string, _k: string, o: unknown) => {
    h.browser.push(o);
    return {};
  },
  parseCookieHeader: () => [],
  serializeCookieHeader: () => '',
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [{ name: 'sb-wacrm-auth-token.1', value: 'tail' }],
    has: () => false,
    set: h.set,
  }),
}));
vi.mock('@/lib/supabase/session-fetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createServerRefresh: () => ({ fetch, bound: (c: unknown) => c }),
}));

import { browserCookies, createClient as createBrowser } from './client';
import { createClient as createServer } from './server';
import { AUTH_COOKIE_MAX_AGE_SECONDS, AUTH_COOKIE_NAME } from './urls';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.example.com');
  h.set.mockClear();
});

describe('session cookie wiring', () => {
  it('the server client caps and writes the whole session', async () => {
    await createServer();
    const { cookies } = h.server.at(-1) as { cookies: Methods };
    cookies.setAll([
      {
        name: `${AUTH_COOKIE_NAME}.0`,
        value: 'head',
        options: { maxAge: 400 * 86_400 },
      },
    ]);
    const options = { maxAge: AUTH_COOKIE_MAX_AGE_SECONDS };
    expect(h.set.mock.calls).toEqual([
      [`${AUTH_COOKIE_NAME}.0`, 'head', options],
      [`${AUTH_COOKIE_NAME}.1`, 'tail', options],
    ]);
  });

  it('the browser client gets our cookie methods', () => {
    vi.stubGlobal('document', { cookie: '' });
    try {
      createBrowser();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(h.browser.at(-1)).toMatchObject({ cookies: browserCookies });
  });
});
