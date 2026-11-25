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
    expect(authCookieOptions(undefined).secure).toBe(false);
  });
});
