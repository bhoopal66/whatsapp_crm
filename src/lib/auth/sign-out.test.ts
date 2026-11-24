import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { SIGN_OUT_WAIT_MS, signOutThisDevice } from './sign-out';
import { statusFromAnswer } from './session-state';

const signedIn = {
  data: { session: { user: { id: 'u1' } } },
  error: null,
};
const nobody = { data: { session: null }, error: null };
const refused = new Error('refused');

function auth(
  error: unknown,
  left: { data: { session: { user: unknown } | null }; error: unknown }
) {
  return {
    signOut: vi.fn(async () => ({ error })),
    getSession: vi.fn(async () => left),
  };
}

afterEach(() => vi.useRealTimers());

describe('signOutThisDevice', () => {
  it('ends the session on this device only', async () => {
    const a = auth(null, nobody);
    expect(await signOutThisDevice(a)).toBe(true);
    expect(a.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('is a sign-out when the server failed but the session is gone', async () => {
    expect(await signOutThisDevice(auth(refused, nobody))).toBe(true);
  });

  it('is not one while a session is left, or may be', async () => {
    expect(await signOutThisDevice(auth(refused, signedIn))).toBe(false);
    expect(
      await signOutThisDevice(
        auth(refused, { ...nobody, error: { name: 'AuthRetryableFetchError' } })
      )
    ).toBe(false);
  });

  it('does not throw', async () => {
    const a = auth(null, signedIn);
    a.signOut.mockRejectedValue(refused);
    expect(await signOutThisDevice(a)).toBe(false);
  });

  it('stops waiting for a server that does not answer', async () => {
    vi.useFakeTimers();
    const a = auth(null, nobody);
    a.signOut.mockReturnValue(new Promise(() => {}));
    const done = signOutThisDevice(a);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_WAIT_MS);
    expect(await done).toBe(true);
  });

  // The real auth-js, against a server that is down.
  it('leaves no session on this device when the server is down', async () => {
    const store = new Map<string, string>();
    store.set(
      'k',
      JSON.stringify({
        access_token: 'a.b.c',
        refresh_token: 'r',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'u1' },
      })
    );
    const fetched: string[] = [];
    const client = createClient('http://supabase.invalid', 'anon', {
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
        fetch: async (url) => {
          fetched.push(String(url));
          return new Response('{}', { status: 503 });
        },
      },
    });
    expect(await signOutThisDevice(client.auth)).toBe(true);
    expect(fetched).toEqual([expect.stringContaining('scope=local')]);
    expect(store.get('k')).toBeUndefined();
  });
});

describe('statusFromAnswer', () => {
  it('only calls it signed out when that is the answer', () => {
    expect(statusFromAnswer({ id: 'u1' }, null)).toBe('signed_in');
    expect(statusFromAnswer(null, null)).toBe('signed_out');
    expect(
      statusFromAnswer(null, { name: 'AuthSessionMissingError', status: 400 })
    ).toBe('signed_out');
    for (const error of [
      { name: 'AuthRetryableFetchError', status: 0 },
      { name: 'AuthRetryableFetchError', status: 502 },
      { name: 'AuthUnknownError' },
      { name: 'AuthApiError', status: 429 },
      new TypeError('Failed to fetch'),
    ]) {
      expect(statusFromAnswer(null, error)).toBe('unknown');
    }
  });
});
