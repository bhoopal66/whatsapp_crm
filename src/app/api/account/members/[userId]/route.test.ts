import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deactivation is two writes that must agree: the profile flag that RLS
// reads (set_member_active, migration 069) and the Supabase Auth ban
// that refuses the sign-in. These tests pin the order — the RPC first,
// because only it authorises the caller — and the rollback when the ban
// fails, so the roster never shows a state the login doesn't have.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  updateUserById: vi.fn(),
  limit: vi.fn(),
  filters: [] as unknown[][],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 }),
  ),
}));

// The service-role read of the person's non-deactivated rows in OTHER
// workspaces (083): the login is shared, so it is banned only when none
// is left.
const otherRows = {
  select: () => otherRows,
  eq: (...args: unknown[]) => (mocks.filters.push(['eq', ...args]), otherRows),
  is: (...args: unknown[]) => (mocks.filters.push(['is', ...args]), otherRows),
  neq: (...args: unknown[]) => (mocks.filters.push(['neq', ...args]), otherRows),
  limit: mocks.limit,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { admin: { updateUserById: mocks.updateUserById } },
    from: () => otherRows,
  }),
}));

vi.mock('@/lib/supabase/urls', () => ({
  serverSupabaseUrl: () => 'http://localhost:8000',
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

import { DELETE, PATCH } from './route';

const ADMIN_CTX = {
  supabase: { rpc: mocks.rpc },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

const params = { params: Promise.resolve({ userId: 'user-2' }) };

describe('PATCH /api/account/members/[userId] { active }', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.updateUserById.mockResolvedValue({ error: null });
    mocks.limit.mockResolvedValue({ data: [], error: null });
    mocks.filters.length = 0;
  });

  it('flags the profile, then bans the login', async () => {
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_active', {
      p_user_id: 'user-2',
      p_active: false,
    });
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-2', {
      ban_duration: '876000h',
    });
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUserById.mock.invocationCallOrder[0],
    );
  });

  it('bans a last membership: only other working rows count', async () => {
    await PATCH(request({ active: false }), params);
    expect(mocks.filters).toEqual([
      ['eq', 'user_id', 'user-2'],
      ['is', 'deactivated_at', null],
      ['neq', 'account_id', 'account-1'],
    ]);
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-2', {
      ban_duration: '876000h',
    });
  });

  it('other membership keeps the login: no ban while another workspace has them', async () => {
    mocks.limit.mockResolvedValue({ data: [{ account_id: 'account-2' }], error: null });
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, active: false });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('puts the flag back when the other memberships cannot be read', async () => {
    mocks.limit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(502);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'set_member_active', {
      p_user_id: 'user-2',
      p_active: true,
    });
  });

  it('reactivating lifts the ban', async () => {
    const res = await PATCH(request({ active: true }), params);
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_active', {
      p_user_id: 'user-2',
      p_active: true,
    });
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-2', {
      ban_duration: 'none',
    });
  });

  it('never touches the login when the RPC refuses the caller', async () => {
    mocks.rpc.mockResolvedValue({
      error: { code: '22023', message: 'The account owner cannot be deactivated' },
    });
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'The account owner cannot be deactivated',
    });
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('puts the flag back when the ban fails', async () => {
    mocks.updateUserById.mockResolvedValue({ error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(502);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'set_member_active', {
      p_user_id: 'user-2',
      p_active: true,
    });
  });

  it('rejects a non-boolean value', async () => {
    const res = await PATCH(request({ active: 'no' }), params);
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('still changes roles when no `active` is sent', async () => {
    const res = await PATCH(request({ role: 'viewer' }), params);
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_role', {
      p_user_id: 'user-2',
      p_new_role: 'viewer',
    });
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/account/members/[userId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
  });

  it('accepts NULL: the person keeps another membership', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const res = await DELETE(request(null), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, newPersonalAccountId: null });
    expect(mocks.rpc).toHaveBeenCalledWith('remove_account_member', {
      p_user_id: 'user-2',
    });
  });

  it('returns the new personal account of someone removed from their only workspace', async () => {
    mocks.rpc.mockResolvedValue({ data: 'account-9', error: null });
    const res = await DELETE(request(null), params);
    expect(await res.json()).toEqual({ ok: true, newPersonalAccountId: 'account-9' });
  });
});
