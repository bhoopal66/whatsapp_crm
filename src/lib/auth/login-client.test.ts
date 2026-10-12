import { describe, expect, it } from 'vitest';

import { loginDestination, loginFailure } from './login-client';

const params = (q: string) => new URLSearchParams(q);

describe('loginDestination', () => {
  it('goes to the invitation first, like the middleware', () => {
    expect(loginDestination(params('invite=a b&next=/inbox'))).toBe(
      '/join/a%20b'
    );
  });

  it('goes to a same-origin next path, else the dashboard', () => {
    expect(loginDestination(params('next=/inbox?c=1#m'))).toBe('/inbox?c=1#m');
    expect(loginDestination(params(''))).toBe('/dashboard');
  });

  it('never leaves the origin', () => {
    for (const next of [
      'https://evil.example/x',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      'inbox',
    ]) {
      expect(loginDestination(params(`next=${encodeURIComponent(next)}`))).toBe(
        '/dashboard'
      );
    }
  });
});

describe('loginFailure', () => {
  it('maps each answer to its message', () => {
    expect(loginFailure(401, { error: 'x' })).toEqual({
      key: 'invalidCredentials',
    });
    expect(loginFailure(400, null)).toEqual({ key: 'invalidCredentials' });
    expect(loginFailure(403, null)).toEqual({ key: 'deactivated' });
    expect(loginFailure(429, null)).toEqual({ key: 'rateLimited' });
    expect(loginFailure(503, null)).toEqual({ key: 'unavailable' });
    expect(loginFailure(500, null)).toEqual({ key: 'genericError' });
    expect(loginFailure(0, null)).toEqual({ key: 'genericError' });
  });

  it('rounds a lock up to whole minutes, 15 when the answer has none', () => {
    expect(loginFailure(423, { retryAfterSeconds: 900 })).toEqual({
      key: 'tooManyAttempts',
      minutes: 15,
    });
    expect(loginFailure(423, { retryAfterSeconds: 61 })).toEqual({
      key: 'tooManyAttempts',
      minutes: 2,
    });
    expect(loginFailure(423, null)).toEqual({
      key: 'tooManyAttempts',
      minutes: 15,
    });
  });
});
