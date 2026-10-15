import { beforeEach, describe, expect, it, vi } from 'vitest';

// A device registers under the caller's RLS client; an endpoint that
// already exists is taken over by a service-role upsert (no client
// UPDATE grant on push_subscriptions).

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  insert: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ upsert: mocks.upsert }) }),
}));

import { POST } from './route';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';
const KEYS = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA',
  auth: 'tBHI-tk_9',
};

const subscribe = (body: unknown) =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

describe('POST /api/push/subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'user-1',
      accountId: 'acct-1',
      role: 'agent',
      supabase: { from: () => ({ insert: mocks.insert }) },
    });
    mocks.insert.mockResolvedValue({ error: null });
    mocks.upsert.mockResolvedValue({ error: null });
  });

  it('inserts the device for the caller and answers 201', async () => {
    const res = await subscribe({
      endpoint: ENDPOINT,
      keys: KEYS,
      userAgent: 'x'.repeat(600),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      endpoint: ENDPOINT,
      p256dh: KEYS.p256dh,
      auth: KEYS.auth,
      user_agent: 'x'.repeat(512),
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('takes an existing endpoint over with a service-role upsert on 23505', async () => {
    mocks.insert.mockResolvedValue({
      error: { code: '23505', message: 'duplicate key' },
    });
    const res = await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect(res.status).toBe(201);
    expect(mocks.upsert).toHaveBeenCalledWith(
      {
        user_id: 'user-1',
        endpoint: ENDPOINT,
        p256dh: KEYS.p256dh,
        auth: KEYS.auth,
        user_agent: null,
        failure_count: 0,
      },
      { onConflict: 'endpoint' }
    );
  });

  it('does not take over on any other insert error', async () => {
    mocks.insert.mockResolvedValue({
      error: { code: '42501', message: 'rls' },
    });
    const res = await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect(res.status).toBe(500);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('answers 500 when the takeover fails', async () => {
    mocks.insert.mockResolvedValue({ error: { code: '23505' } });
    mocks.upsert.mockResolvedValue({ error: { message: 'boom' } });
    expect((await subscribe({ endpoint: ENDPOINT, keys: KEYS })).status).toBe(
      500
    );
  });

  it.each([
    ['an http endpoint', { endpoint: 'http://push.example.com/x', keys: KEYS }],
    ['a non-URL endpoint', { endpoint: 'not a url', keys: KEYS }],
    [
      'an endpoint over 2048 chars',
      { endpoint: `https://p.example.com/${'a'.repeat(2048)}`, keys: KEYS },
    ],
    ['missing keys', { endpoint: ENDPOINT }],
    ['an empty key', { endpoint: ENDPOINT, keys: { ...KEYS, auth: '' } }],
    [
      'a non-base64url key',
      { endpoint: ENDPOINT, keys: { ...KEYS, p256dh: 'a+b/c' } },
    ],
    [
      'a key over 256 chars',
      { endpoint: ENDPOINT, keys: { ...KEYS, auth: 'a'.repeat(257) } },
    ],
    ['a malformed body', 'not json'],
  ])('refuses %s before writing', async (_label, body) => {
    expect((await subscribe(body)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
