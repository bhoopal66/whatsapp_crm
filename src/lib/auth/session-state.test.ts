import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';

import { markExplicitSignOut, wasExplicitSignOut } from './explicit-sign-out';
import {
  forgetRefreshFailure,
  loginPathFor,
  recheckDelayMs,
  retryAction,
  statusFromEvent,
} from './session-state';

it('takes no session for a sign-out only when that is the event', () => {
  expect(statusFromEvent('INITIAL_SESSION', null)).toBeNull();
  expect(statusFromEvent('SIGNED_OUT', null)).toBe('signed_out');
  expect(statusFromEvent('TOKEN_REFRESHED', { id: 'u1' })).toBe('signed_in');
});

it('asks again after 1 s, then less often, up to 30 s', () => {
  expect([0, 1, 4, 5, 40].map(recheckDelayMs)).toEqual([
    1_000, 2_000, 16_000, 30_000, 30_000,
  ]);
});

it('reloads on Retry only when asking again will not do, and online', () => {
  const state = { online: true, retries: 0, checkingForMs: null };
  expect(retryAction(state)).toBe('check');
  expect(retryAction({ ...state, retries: 1 })).toBe('reload');
  expect(retryAction({ ...state, checkingForMs: 10_000 })).toBe('reload');
  expect(retryAction({ ...state, retries: 1, online: false })).toBe('check');
});

it('remembers the page, except after a sign-out on purpose', () => {
  expect(loginPathFor('/inbox?c=1&d=2', false)).toBe(
    '/login?next=%2Finbox%3Fc%3D1%26d%3D2'
  );
  expect(loginPathFor('/inbox', true)).toBe('/login');
  expect(loginPathFor('/', false)).toBe('/login');
  expect(loginPathFor('//evil.example', false)).toBe('/login');
});

it('a sign-out on purpose is remembered for a short while', () => {
  expect(wasExplicitSignOut()).toBe(false);
  markExplicitSignOut();
  expect(wasExplicitSignOut()).toBe(true);
  expect(wasExplicitSignOut(Date.now() + 30_000)).toBe(false);
});

// The real auth-js, whose refresh fails and then works.
it('asks again although auth-js remembers the failure', async () => {
  vi.useFakeTimers();
  let up = false;
  const session = (expiresIn: number) => ({
    access_token: 'a.b.c',
    refresh_token: 'r',
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: { id: 'u1' },
  });
  const store = new Map([['k', JSON.stringify(session(-10))]]);
  const { auth } = createClient('http://supabase.invalid', 'anon', {
    auth: {
      storageKey: 'k',
      autoRefreshToken: false,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    },
    global: {
      fetch: async () =>
        up
          ? Response.json(session(3_600))
          : new Response('{}', { status: 503 }),
    },
  });
  const ask = async () => {
    const answer = auth.getSession();
    await vi.advanceTimersByTimeAsync(30_000);
    return (await answer).data.session?.user.id;
  };
  expect(await ask()).toBeUndefined();
  up = true;
  expect((await auth.getSession()).data.session).toBeNull();
  forgetRefreshFailure(auth);
  expect(await ask()).toBe('u1');
  vi.useRealTimers();
});
