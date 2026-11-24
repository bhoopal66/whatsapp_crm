import fs from 'node:fs';
import path from 'node:path';

import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthUnknownError,
} from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { authUnavailableResponse, isAuthUnavailable } from './auth-unavailable';

describe('isAuthUnavailable', () => {
  it('is true only for a failure that says nothing about the session', () => {
    expect(isAuthUnavailable(new AuthRetryableFetchError('x', 0))).toBe(true);
    expect(isAuthUnavailable(new AuthRetryableFetchError('x', 502))).toBe(true);
    expect(isAuthUnavailable(new AuthApiError('x', 500, undefined))).toBe(true);
    expect(isAuthUnavailable({ status: 0 })).toBe(true);
    expect(isAuthUnavailable(new AuthApiError('x', 429, 'c'))).toBe(true);
    expect(isAuthUnavailable(new AuthUnknownError('x', null))).toBe(true);
    for (const status of [400, 401, 403]) {
      expect(isAuthUnavailable(new AuthApiError('x', status, 'c'))).toBe(false);
    }
    expect(
      isAuthUnavailable({ name: 'AuthSessionMissingError', status: 400 })
    ).toBe(false);
    expect(isAuthUnavailable(null)).toBe(false);
    expect(isAuthUnavailable(undefined)).toBe(false);
  });

  it('answers 503 { error }', async () => {
    const res = authUnavailableResponse();
    expect(res.status).toBe(503);
    expect(typeof (await res.json()).error).toBe('string');
  });
});

describe('every API route that asks who is signed in', () => {
  const root = path.join(process.cwd(), 'src/app/api');
  const routes = (fs.readdirSync(root, { recursive: true }) as string[]).filter(
    (f) => path.basename(f) === 'route.ts'
  );
  // Reads only the email of a caller `requireRole` already loaded.
  const EXEMPT = new Set(['pbx/softphone/signature/route.ts']);

  it.each(
    routes.filter(
      (f) =>
        !EXEMPT.has(f) &&
        fs.readFileSync(path.join(root, f), 'utf8').includes('auth.getUser()')
    )
  )('%s tells an outage from a missing session', (file) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const asks = src.split('auth.getUser()').length - 1;
    const checks = src.split('isAuthUnavailable(').length - 1;
    expect(checks).toBe(asks);
  });
});
