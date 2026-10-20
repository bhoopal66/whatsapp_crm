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

describe('PUT coordinator-banks', () => {
  it('rejects a bad id and bad bodies without calling the RPC', async () => {
    expect((await put({ bank_codes: [] }, 'x')).status).toBe(400);
    expect((await put('not json')).status).toBe(400);
    expect((await put({ bank_codes: ['bad'] })).status).toBe(400);
    expect((await put({ bank_codes: ['ADCB', 'ADCB'] })).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('calls the RPC and returns the stored codes', async () => {
    mocks.rpc.mockResolvedValue({ data: ['ADCB'], error: null });
    const res = await put({ bank_codes: ['ADCB'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bank_codes: ['ADCB'] });
    expect(mocks.rpc).toHaveBeenCalledWith('set_coordinator_banks', {
      p_user_id: USER,
      p_bank_codes: ['ADCB'],
    });
  });

  it('maps RPC errors', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', hint: 'not_eligible', message: 'raw' },
    });
    const res = await put({ bank_codes: ['ADCB'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/raw/);

    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    expect((await put({ bank_codes: [] })).status).toBe(403);
  });
});
