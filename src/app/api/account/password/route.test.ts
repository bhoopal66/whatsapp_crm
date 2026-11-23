import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AuthLockout,
  DEFAULT_SCOPES,
  MemoryLockoutStore,
  MemoryRateStore,
  RateLimiter,
  type AdminCtx,
} from '@/lib/edge';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  verify: vi.fn(),
  throwawaySignOut: vi.fn(),
  throwawayOptions: vi.fn(),
  guards: null as unknown as AdminCtx,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: mocks.getUser,
      updateUser: mocks.updateUser,
      signOut: mocks.signOut,
    },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    mocks.throwawayOptions(options);
    return {
      auth: {
        signInWithPassword: mocks.verify,
        signOut: mocks.throwawaySignOut,
      },
    };
  },
}));
vi.mock('@/lib/auth/edge-guards', () => ({
  edgeAuthGuards: () => mocks.guards,
}));

import { POST } from './route';

let n = 0;
let userId: string;
let store: MemoryLockoutStore;

async function change(
  body: unknown = { currentPassword: 'old-pass', newPassword: 'new-pass-1' },
  type = 'application/json'
) {
  return POST(
    new Request('https://crm.example.com/api/account/password', {
      method: 'POST',
      headers: { 'content-type': type, 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.stubEnv('EDGE_CLIENT_IP_HEADER', 'cf-connecting-ip');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  userId = `u${++n}`;
  store = new MemoryLockoutStore();
  vi.spyOn(store, 'fail');
  mocks.guards = {
    lockout: new AuthLockout(store),
    limiter: new RateLimiter(new MemoryRateStore(), DEFAULT_SCOPES, {
      warn: vi.fn(),
    }),
  };
  mocks.getUser.mockReset().mockResolvedValue({
    data: { user: { id: userId, email: 'Alice@Example.com' } },
    error: null,
  });
  mocks.verify
    .mockReset()
    .mockImplementation(async ({ password }: { password: string }) =>
      password === 'old-pass'
        ? { data: { user: { id: userId } }, error: null }
        : {
            data: { user: null },
            error: { status: 400, code: 'invalid_credentials' },
          }
    );
  mocks.updateUser.mockReset().mockResolvedValue({ error: null });
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.throwawaySignOut.mockReset().mockResolvedValue({ error: null });
  mocks.throwawayOptions.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/account/password', () => {
  it('checks on a cookie-less client, changes it, signs out the others', async () => {
    const res = await change();
    expect(res.status).toBe(200);
    expect(mocks.throwawayOptions).toHaveBeenCalledWith({
      auth: { autoRefreshToken: false, persistSession: false },
    });
    expect(mocks.verify).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'old-pass',
    });
    expect(mocks.throwawaySignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: 'new-pass-1' });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('refuses a caller who is not signed in, and answers 503 on an outage', async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthSessionMissingError', status: 400 },
    });
    expect((await change()).status).toBe(401);
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', status: 0 },
    });
    expect((await change()).status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('counts a wrong password and locks on the fifth, as sign-in does', async () => {
    const wrong = { currentPassword: 'nope', newPassword: 'new-pass-1' };
    for (let i = 0; i < 5; i++) {
      expect((await change(wrong)).status).toBe(403);
    }
    expect(store.fail).toHaveBeenCalledTimes(5);
    const res = await change();
    expect(res.status).toBe(423);
    expect((await res.json()).retryAfterSeconds).toBeGreaterThan(0);
    expect(mocks.verify).toHaveBeenCalledTimes(5);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('is rate limited per user', async () => {
    for (let i = 0; i < 10; i++) await change({});
    expect((await change()).status).toBe(429);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('never changes it when the check answers for another login', async () => {
    mocks.verify.mockResolvedValue({
      data: { user: { id: 'someone-else' } },
      error: null,
    });
    expect((await change()).status).toBe(403);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('does not count GoTrue being down', async () => {
    mocks.verify.mockResolvedValue({ data: {}, error: { status: 502 } });
    expect((await change()).status).toBe(503);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('refuses bad input before the check', async () => {
    expect((await change({ currentPassword: 'old-pass' })).status).toBe(400);
    expect((await change(undefined, 'text/plain')).status).toBe(400);
    expect(
      (await change({ currentPassword: 'old-pass', newPassword: 'short' }))
        .status
    ).toBe(422);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('answers 422 for a password GoTrue refuses, without its wording', async () => {
    mocks.updateUser.mockResolvedValue({
      error: { status: 422, code: 'same_password', message: 'raw' },
    });
    const res = await change();
    expect(res.status).toBe(422);
    expect((await res.json()).error).not.toContain('raw');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('still answers ok when the other sessions could not be signed out', async () => {
    mocks.signOut.mockResolvedValue({ error: { status: 500 } });
    expect((await change()).status).toBe(200);
  });
});
