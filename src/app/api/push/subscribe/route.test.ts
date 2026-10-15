import { beforeEach, describe, expect, it, vi } from 'vitest';

// A device registers under the caller's RLS client; an endpoint that
// already exists is updated by the service role (no client UPDATE grant
// on push_subscriptions), only for its own holder or the same keys.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  insert: vi.fn(),
  upsert: vi.fn(),
  existing: vi.fn(),
  update: vi.fn(),
  updateEq: vi.fn(),
  updated: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      upsert: mocks.upsert,
      select: () => ({
        eq: () => ({ maybeSingle: () => mocks.existing() }),
      }),
      update: (patch: unknown) => {
        mocks.update(patch);
        const q = {
          eq: (c: string, v: unknown) => (mocks.updateEq(c, v), q),
          select: () => mocks.updated(),
        };
        return q;
      },
    }),
  }),
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
    mocks.existing.mockResolvedValue({ data: null, error: null });
    mocks.updated.mockResolvedValue({ data: [{ id: 's1' }], error: null });
  });

  const collide = (existing: Record<string, unknown> | null) => {
    mocks.insert.mockResolvedValue({
      error: { code: '23505', message: 'duplicate key' },
    });
    mocks.existing.mockResolvedValue({ data: existing, error: null });
  };

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

  it('takes over another login’s row when the posted keys match it', async () => {
    collide({ user_id: 'user-0', ...KEYS });
    const res = await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect(res.status).toBe(201);
    expect(mocks.update).toHaveBeenCalledWith({
      user_id: 'user-1',
      endpoint: ENDPOINT,
      p256dh: KEYS.p256dh,
      auth: KEYS.auth,
      user_agent: null,
      failure_count: 0,
    });
    // Conditional on exactly the row that was judged.
    expect(mocks.updateEq.mock.calls).toEqual([
      ['endpoint', ENDPOINT],
      ['user_id', 'user-0'],
      ['p256dh', KEYS.p256dh],
      ['auth', KEYS.auth],
    ]);
  });

  it('refreshes the caller’s own row whose keys rotated', async () => {
    collide({ user_id: 'user-1', p256dh: 'old', auth: 'old' });
    const res = await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect(res.status).toBe(201);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('refuses someone else’s endpoint posted with different keys', async () => {
    collide({ user_id: 'user-0', p256dh: 'other', auth: KEYS.auth });
    const res = await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/registered to someone else/);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('answers 409 when the row changed between the read and the update', async () => {
    collide({ user_id: 'user-0', ...KEYS });
    mocks.updated.mockResolvedValue({ data: [], error: null });
    expect((await subscribe({ endpoint: ENDPOINT, keys: KEYS })).status).toBe(
      409
    );
  });

  it('upserts when the colliding row was deleted before it could be read', async () => {
    collide(null);
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
    collide({ user_id: 'user-1', ...KEYS });
    mocks.updated.mockResolvedValue({ data: null, error: { message: 'boom' } });
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
