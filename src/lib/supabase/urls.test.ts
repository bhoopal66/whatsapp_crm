import { describe, expect, it } from 'vitest';

import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  authCookieOptions,
} from './urls';

describe('authCookieOptions', () => {
  it('is secure on https, with a 7-day idle limit and the pinned name', () => {
    expect(authCookieOptions('https://crm.example.com/supabase')).toEqual({
      name: AUTH_COOKIE_NAME,
      path: '/',
      sameSite: 'lax',
      maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
      secure: true,
    });
    expect(AUTH_COOKIE_MAX_AGE_SECONDS).toBe(604800);
  });
  it('keeps local http development working', () => {
    expect(authCookieOptions('http://localhost:8000').secure).toBe(false);
    // No public URL configured at all. (Passing `undefined` would take
    // the default, the env's URL, which CI sets to an https one.)
    expect(authCookieOptions('').secure).toBe(false);
  });
  it('follows the configured public URL by default', () => {
    const before = process.env.NEXT_PUBLIC_SUPABASE_URL;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://crm.example.com';
      expect(authCookieOptions().secure).toBe(true);
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:8000';
      expect(authCookieOptions().secure).toBe(false);
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = before;
    }
  });
});
