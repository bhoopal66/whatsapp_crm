import { beforeEach, describe, expect, it, vi } from 'vitest';

// Migration 190 refuses a personal number as the default or a route
// target (SQLSTATE 22023, HINT PERSONAL_NUMBER); the route turns that
// into a 409 the admin can read instead of a bare 500.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/whatsapp/channels', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadChannels: async () => [{ id: 'cfg-1' }],
}));

import { PUT } from './route';

const refused = {
  code: '22023',
  hint: 'PERSONAL_NUMBER',
  message: 'a personal number cannot be a route',
};

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

describe('PUT /api/whatsapp/routes — personal numbers (190)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.requireRole.mockResolvedValue({
      accountId: 'account-1',
      supabase: {
        rpc: mocks.rpc,
        from: () => ({ upsert: mocks.upsert }),
      },
    });
  });

  it('answers 409 when set_primary_channel refuses a personal number', async () => {
    mocks.rpc.mockResolvedValue({ error: refused });
    const res = await PUT(request({ primary_config_id: 'cfg-1' }));
    expect(res.status).toBe(409);
  });

  it('answers 409 when the routes upsert refuses a personal number', async () => {
    mocks.upsert.mockResolvedValue({ error: refused });
    const res = await PUT(request({ routes: { broadcast: 'cfg-1' } }));
    expect(res.status).toBe(409);
  });
});
