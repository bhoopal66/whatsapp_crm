import { createServerClient } from '@supabase/ssr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserCookies, createClient } from './client';
import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  authCookieOptions,
  sessionCookieWrite,
} from './urls';

const session = JSON.stringify({ access_token: 'a', refresh_token: 'r' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the session cookie ends after the idle limit', () => {
  it('a library write is shortened, a removal stays a removal', () => {
    expect(sessionCookieWrite({ maxAge: 400 * 86_400 }).maxAge).toBe(
      AUTH_COOKIE_MAX_AGE_SECONDS
    );
    const none: { maxAge?: number } = {};
    expect(sessionCookieWrite(none).maxAge).toBe(AUTH_COOKIE_MAX_AGE_SECONDS);
    expect(sessionCookieWrite({ maxAge: 0, path: '/' })).toEqual({
      maxAge: 0,
      path: '/',
    });
  });

  // The reason for sessionCookieWrite: if a later @supabase/ssr honours
  // cookieOptions.maxAge this fails, and the wrapper can go.
  it('@supabase/ssr ignores cookieOptions.maxAge on its own', async () => {
    const written: Array<number | undefined> = [];
    const client = createServerClient('https://x.example.com', 'anon', {
      cookieOptions: authCookieOptions('https://x.example.com'),
      cookies: {
        getAll: () => [],
        setAll: (all) => all.forEach((c) => written.push(c.options.maxAge)),
      },
    });
    const jwt = (payload: object) =>
      [{ alg: 'HS256' }, payload, 'sig']
        .map((p) => Buffer.from(JSON.stringify(p)).toString('base64url'))
        .join('.');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 'u', aud: 'authenticated' }))
    );
    await client.auth.setSession({
      access_token: jwt({
        sub: 'u',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      refresh_token: 'r',
    });
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
    expect(Math.max(...written.map((m) => m ?? 0))).toBeGreaterThan(
      AUTH_COOKIE_MAX_AGE_SECONDS
    );
  });

  it('the browser writes at most the limit, Secure, and reads back', () => {
    let line = '';
    const doc = {
      get cookie() {
        return `${AUTH_COOKIE_NAME}=v1; other=x`;
      },
      set cookie(v: string) {
        line = v;
      },
    };
    vi.stubGlobal('document', doc);
    const { name: _name, ...options } = authCookieOptions(
      'https://crm.example.com'
    );
    void _name;
    browserCookies.setAll!(
      [
        {
          name: AUTH_COOKIE_NAME,
          value: session,
          options: { ...options, maxAge: 400 * 86_400 },
        },
      ],
      {}
    );
    expect(line).toContain(`Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`);
    expect(line).toContain('Secure');
    expect(line).toContain('Path=/');
    browserCookies.setAll!(
      [{ name: AUTH_COOKIE_NAME, value: '', options: { maxAge: 0 } }],
      {}
    );
    expect(line).toContain('Max-Age=0');
    expect(browserCookies.getAll!()).toContainEqual({
      name: AUTH_COOKIE_NAME,
      value: 'v1',
    });
  });

  it('a pre-render still gets a client (no document)', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.example.com');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    expect(() => createClient()).not.toThrow();
  });
});
