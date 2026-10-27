import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { PUT } from './route';

const USER = '11111111-1111-4111-8111-111111111111';

function put(body: unknown, userId = USER) {
  return PUT(
    new Request('http://localhost/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc },
    accountId: 'a',
    userId: 'u',
    role: 'admin',
  });
});

describe('PUT coordinator-phone', () => {
  it('rejects a bad id and bad bodies without calling the RPC', async () => {
    expect((await put({ phone: null }, 'x')).status).toBe(400);
    expect((await put('not json')).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ phone: 971501234567 })).status).toBe(400);
    expect((await put({ phone: '050 123 4567' })).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('normalises the number to digits before the RPC', async () => {
    mocks.rpc.mockResolvedValue({ data: '971501234567', error: null });
    const res = await put({ phone: '+971 50 123 4567' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ phone: '971501234567' });
    expect(mocks.rpc).toHaveBeenCalledWith('set_coordinator_phone', {
      p_user_id: USER,
      p_phone: '971501234567',
    });
  });

  it('clears on null or blank', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    for (const phone of [null, '   ']) {
      const res = await put({ phone });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ phone: null });
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenLastCalledWith('set_coordinator_phone', {
      p_user_id: USER,
      p_phone: null,
    });
  });

  it('maps RPC errors', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', hint: 'not_eligible', message: 'raw' },
    });
    const res = await put({ phone: '971501234567' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/raw/);

    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    expect((await put({ phone: null })).status).toBe(403);
  });
});
