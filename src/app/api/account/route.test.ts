import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings → Workspace renames the workspace through this PATCH: a name,
// a short name (the rail's tile), or both. Only the fields sent are
// written, each under create_workspace()'s rule, and only an admin+
// reaches the UPDATE at all.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: vi.fn(),
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

import { PATCH } from './route';

const chain = {
  update: (...args: unknown[]) => (mocks.update(...args), chain),
  eq: (...args: unknown[]) => (mocks.eq(...args), chain),
  select: (...args: unknown[]) => (mocks.select(...args), chain),
  single: mocks.single,
};

const ADMIN_CTX = {
  supabase: { from: (table: string) => (table === 'accounts' ? chain : null) },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
};

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

const saved = { id: 'account-1', name: 'Taamul', short_name: 'TA' };

describe('PATCH /api/account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.single.mockResolvedValue({ data: saved, error: null });
  });

  it('is admin+, and a refused caller writes nothing', async () => {
    mocks.requireRole.mockRejectedValue(new Error('Forbidden'));
    const res = await PATCH(request({ name: 'Taamul' }));
    expect(res.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('renames only: trims the name and leaves the short name alone', async () => {
    const res = await PATCH(request({ name: '  Taamul Connect  ' }));
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ name: 'Taamul Connect' });
    expect(mocks.eq).toHaveBeenCalledWith('id', 'account-1');
    expect(mocks.select).toHaveBeenCalledWith('id, name, short_name');
    expect(await res.json()).toEqual({ account: saved });
  });

  it('changes only the short name, trimmed, keeping its case', async () => {
    const res = await PATCH(request({ short_name: ' tc2 ' }));
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ short_name: 'tc2' });
  });

  it('changes both in one write', async () => {
    const res = await PATCH(request({ name: 'Taamul', short_name: 'TA' }));
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      name: 'Taamul',
      short_name: 'TA',
    });
  });

  it.each([
    [null, "Send 'name' or 'short_name'"],
    [{}, "Send 'name' or 'short_name'"],
    [{ name: 42 }, "'name' must be a string"],
    [{ name: '   ' }, 'Account name cannot be empty'],
    [{ name: 'x'.repeat(81) }, 'Account name must be 80 characters or fewer'],
    [{ short_name: '' }, "'short_name' must be 1–4 letters or digits"],
    [{ short_name: 'TCONN' }, "'short_name' must be 1–4 letters or digits"],
    [{ short_name: 'T C' }, "'short_name' must be 1–4 letters or digits"],
    [{ short_name: 'تع' }, "'short_name' must be 1–4 letters or digits"],
    [{ short_name: 7 }, "'short_name' must be 1–4 letters or digits"],
    // One bad field refuses the whole request: nothing half-saved.
    [
      { name: 'Taamul', short_name: 'TOOLONG' },
      "'short_name' must be 1–4 letters or digits",
    ],
  ])('answers %j with a 400', async (body, error) => {
    const res = await PATCH(request(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers a database error with a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.single.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await PATCH(request({ short_name: 'TC' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update account' });
  });
});
