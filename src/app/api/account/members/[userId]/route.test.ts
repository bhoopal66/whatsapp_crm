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
  /** The other workspaces that are not archived. */
  openWorkspaces: vi.fn(),
  disconnectPersonal: vi.fn(),
  cutMember: vi.fn(),
  filters: [] as unknown[][],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

// The service-role read of the person's non-deactivated rows in OTHER
// workspaces (083): the login is shared, so it is banned only when none
// is left.
const otherRows = {
  select: () => otherRows,
  eq: (...args: unknown[]) => (mocks.filters.push(['eq', ...args]), otherRows),
  is: (...args: unknown[]) => (mocks.filters.push(['is', ...args]), otherRows),
  neq: (...args: unknown[]) => (
    mocks.filters.push(['neq', ...args]),
    otherRows
  ),
  limit: mocks.limit,
};

const openRows = {
  select: () => openRows,
  in: (...args: unknown[]) => (
    mocks.filters.push(['accounts.in', ...args]),
    openRows
  ),
  is: (...args: unknown[]) => (
    mocks.filters.push(['accounts.is', ...args]),
    openRows
  ),
  limit: mocks.openWorkspaces,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { admin: { updateUserById: mocks.updateUserById } },
    from: (table: string) => (table === 'accounts' ? openRows : otherRows),
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

vi.mock('@/lib/whatsapp/personal-offboarding', () => ({
  disconnectPersonalNumbersOf: mocks.disconnectPersonal,
}));

vi.mock('@/lib/meetings/cut', () => ({ cutMemberSeats: mocks.cutMember }));

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
    mocks.openWorkspaces.mockResolvedValue({
      data: [{ id: 'account-2' }],
      error: null,
    });
    mocks.disconnectPersonal.mockResolvedValue(true);
    mocks.filters.length = 0;
  });

  it('disconnects the personal number once the deactivation stands', async () => {
    const res = await PATCH(request({ active: false }), params);
    expect(await res.json()).toEqual({
      ok: true,
      active: false,
      banned: true,
    });
    expect(mocks.disconnectPersonal).toHaveBeenCalledTimes(1);
    expect(mocks.disconnectPersonal.mock.calls[0].slice(1)).toEqual([
      'account-1',
      'user-2',
    ]);
    expect(mocks.updateUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disconnectPersonal.mock.invocationCallOrder[0]
    );
  });

  it('disconnects it when they keep another workspace too', async () => {
    mocks.limit.mockResolvedValue({
      data: [{ account_id: 'a2' }],
      error: null,
    });
    await PATCH(request({ active: false }), params);
    expect(mocks.disconnectPersonal).toHaveBeenCalledTimes(1);
  });

  it('only warns when the number could not be disconnected', async () => {
    mocks.disconnectPersonal.mockResolvedValue(false);
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      active: false,
      banned: true,
      warning: 'personal_number_not_disconnected',
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('cuts the call they are in once the deactivation stands', async () => {
    await PATCH(request({ active: false }), params);
    expect(mocks.cutMember).toHaveBeenCalledTimes(1);
    expect(mocks.cutMember.mock.calls[0].slice(1)).toEqual([
      'account-1',
      'user-2',
    ]);
    expect(mocks.updateUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cutMember.mock.invocationCallOrder[0]
    );
  });

  it('cuts it when they keep another workspace too', async () => {
    mocks.limit.mockResolvedValue({
      data: [{ account_id: 'a2' }],
      error: null,
    });
    await PATCH(request({ active: false }), params);
    expect(mocks.cutMember).toHaveBeenCalledTimes(1);
  });

  it('cuts nobody on a failed deactivation, a reactivation or a role', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.updateUserById.mockResolvedValueOnce({ error: { message: 'x' } });
    await PATCH(request({ active: false }), params);
    await PATCH(request({ active: true }), params);
    await PATCH(request({ role: 'viewer' }), params);
    expect(mocks.cutMember).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('leaves the number alone on a failed deactivation or a reactivation', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.updateUserById.mockResolvedValueOnce({ error: { message: 'x' } });
    await PATCH(request({ active: false }), params);
    await PATCH(request({ active: true }), params);
    expect(mocks.disconnectPersonal).not.toHaveBeenCalled();
    spy.mockRestore();
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
      mocks.updateUserById.mock.invocationCallOrder[0]
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
    mocks.limit.mockResolvedValue({
      data: [{ account_id: 'account-2' }],
      error: null,
    });
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      active: false,
      banned: false,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('bans a login whose only other workspace is archived', async () => {
    mocks.filters.length = 0;
    mocks.limit.mockResolvedValue({
      data: [{ account_id: 'account-2' }],
      error: null,
    });
    mocks.openWorkspaces.mockResolvedValue({ data: [], error: null });
    const res = await PATCH(request({ active: false }), params);
    expect((await res.json()).banned).toBe(true);
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-2', {
      ban_duration: '876000h',
    });
    expect(mocks.filters).toContainEqual(['accounts.in', 'id', ['account-2']]);
    expect(mocks.filters).toContainEqual(['accounts.is', 'archived_at', null]);
  });

  it('changes nothing when the other workspaces cannot be read', async () => {
    mocks.limit.mockResolvedValue({
      data: [{ account_id: 'account-2' }],
      error: null,
    });
    mocks.openWorkspaces.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('changes nothing when the other memberships cannot be read', async () => {
    mocks.limit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Nothing was changed');
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('bans a login whose last other workspace let it go meanwhile', async () => {
    mocks.limit
      .mockResolvedValueOnce({
        data: [{ account_id: 'account-2' }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(200);
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-2', {
      ban_duration: '876000h',
    });
  });

  it('keeps the login when only the second look fails', async () => {
    mocks.limit
      .mockResolvedValueOnce({
        data: [{ account_id: 'account-2' }],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await PATCH(request({ active: false }), params);
    expect(res.status).toBe(200);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('says what was cleared when a failed ban undoes a deactivation', async () => {
    mocks.updateUserById.mockResolvedValue({ error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await PATCH(request({ active: false }), params)).json();
    expect(body.code).toBe('deactivation_undone');
    expect(body.error).toMatch(/active again.*team, phone extension/);
    expect(body.error).not.toContain('Nothing was changed');
  });

  it.each([
    [false, 'deactivation_half_done'],
    [true, 'reactivation_half_done'],
  ])(
    'says so when the flag could not be put back (active: %s)',
    async (active, code) => {
      mocks.updateUserById.mockResolvedValue({ error: { message: 'boom' } });
      mocks.rpc
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: { code: 'XX000', message: 'boom' } });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await PATCH(request({ active }), params);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(body.error).not.toContain('Nothing was changed');
    }
  );

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
      error: {
        code: '22023',
        message: 'The account owner cannot be deactivated',
      },
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

describe('PATCH /api/account/members/[userId] { personalWhatsapp }', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it('calls set_member_personal_whatsapp and answers ok', async () => {
    const res = await PATCH(request({ personalWhatsapp: true }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_personal_whatsapp', {
      p_user_id: 'user-2',
      p_allowed: true,
    });
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean value without calling the RPC', async () => {
    const res = await PATCH(request({ personalWhatsapp: 'yes' }), params);
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      { code: '22023', hint: 'PERSONAL_NUMBER_EXISTS' },
      409,
      'personal_number_exists',
    ],
    [{ code: '22023', hint: 'not_eligible' }, 422, 'not_eligible'],
    [{ code: 'P0002' }, 404, undefined],
    [{ code: '42501', message: 'nope' }, 403, undefined],
    [{ code: 'XX000', message: 'boom' }, 500, undefined],
  ])('maps %j to %i', async (err, status, body) => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ error: err });
    const res = await PATCH(request({ personalWhatsapp: false }), params);
    expect(res.status).toBe(status);
    if (body) expect(await res.json()).toEqual({ error: body });
    consoleError.mockRestore();
  });
});

describe('PATCH /api/account/members/[userId] { reviewAllCalls }', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it('calls set_member_call_review and answers ok', async () => {
    const res = await PATCH(request({ reviewAllCalls: true }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_call_review', {
      p_user_id: 'user-2',
      p_allowed: true,
    });
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean value without calling the RPC', async () => {
    const res = await PATCH(request({ reviewAllCalls: 'yes' }), params);
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: '22023', hint: 'not_eligible' }, 422],
    [{ code: '22023', message: 'bad value' }, 400],
    [{ code: 'P0002' }, 404],
    [{ code: '42501', message: 'nope' }, 403],
    [{ code: 'XX000', message: 'boom' }, 500],
  ])('maps %j to %i', async (err, status) => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ error: err });
    const res = await PATCH(request({ reviewAllCalls: false }), params);
    expect(res.status).toBe(status);
    expect(typeof (await res.json()).error).toBe('string');
    consoleError.mockRestore();
  });
});

describe('PATCH /api/account/members/[userId] { department }', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it('calls set_member_department and answers ok', async () => {
    const res = await PATCH(request({ department: 'hr' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_department', {
      p_user_id: 'user-2',
      p_department: 'hr',
    });
  });

  it.each(['marketing', 5, null])(
    'rejects %j without calling the RPC',
    async (department) => {
      const res = await PATCH(request({ department }), params);
      expect(res.status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ code: '42501', message: 'nope' }, 403],
    [{ code: '22023', message: 'bad', hint: 'bad_department' }, 400],
    [{ code: 'P0002', message: 'none' }, 404],
    [{ code: 'XX000', message: 'boom' }, 500],
  ])('maps %j to %i', async (err, status) => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ error: err });
    const res = await PATCH(request({ department: 'it' }), params);
    expect(res.status).toBe(status);
    consoleError.mockRestore();
  });
});

describe('DELETE /api/account/members/[userId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.disconnectPersonal.mockResolvedValue(true);
  });

  it('disconnects the removed person’s number, and warns if it could not', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.disconnectPersonal.mockResolvedValue(false);
    const res = await DELETE(request(null), params);
    expect(await res.json()).toMatchObject({
      ok: true,
      warning: 'personal_number_not_disconnected',
    });
    expect(mocks.disconnectPersonal.mock.calls[0].slice(1)).toEqual([
      'account-1',
      'user-2',
    ]);
  });

  it('cuts the call the removed person is in, and only once removed', async () => {
    mocks.cutMember.mockClear();
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await DELETE(request({}), params);
    expect(mocks.cutMember.mock.calls.map((c) => c.slice(1))).toEqual([
      ['account-1', 'user-2'],
    ]);
    mocks.cutMember.mockClear();
    mocks.rpc.mockResolvedValue({
      error: { code: '42501', message: 'no' },
    });
    await DELETE(request({}), params);
    expect(mocks.cutMember).not.toHaveBeenCalled();
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
    expect(await res.json()).toEqual({
      ok: true,
      newPersonalAccountId: 'account-9',
    });
  });
});
