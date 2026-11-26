import { beforeEach, describe, expect, it, vi } from 'vitest';

// Editing another member's name and login email changes how they sign
// in and what every workspace shows, so the order is what these tests
// pin: the database decides first (authorize_member_details_change,
// migration 167, as the caller), then GoTrue gets a new email, then the
// profiles rows, and the audit row comes last. A profiles failure puts
// the old email back in GoTrue.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  adminRpc: vi.fn(),
  permit: vi.fn(),
  updateUserById: vi.fn(),
  getUserById: vi.fn(),
  readProfile: vi.fn(),
  updateProfiles: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      admin: {
        updateUserById: mocks.updateUserById,
        getUserById: mocks.getUserById,
      },
    },
    rpc: (name: string, args: unknown) =>
      name === 'permit_login_email'
        ? mocks.permit(args)
        : mocks.adminRpc(name, args),
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (c1: string, v1: string) => ({
            eq: (c2: string, v2: string) => ({
              maybeSingle: () => mocks.readProfile({ [c1]: v1, [c2]: v2 }),
            }),
          }),
        }),
        update: (values: unknown) => {
          const filters: Record<string, string> = {};
          const builder = {
            eq: (col: string, val: string) => {
              filters[col] = val;
              return builder;
            },
            select: () => mocks.updateProfiles(values, filters),
          };
          return builder;
        },
      };
    },
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

import { PATCH } from './route';

const ADMIN_CTX = {
  supabase: { rpc: mocks.rpc },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

const CURRENT = { full_name: 'Sara Ali', email: 'sara@old.example' };

/** A tab from before `expected_*` (and, with them, any tab). */
function rawRequest(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

/** What the dialog sends when it showed CURRENT. */
function request(body: object): Request {
  return rawRequest({
    expected_full_name: CURRENT.full_name,
    expected_email: CURRENT.email,
    ...body,
  });
}

const params = { params: Promise.resolve({ userId: 'user-2' }) };

describe('PATCH /api/account/members/[userId]/details', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.adminRpc.mockResolvedValue({ error: null });
    mocks.permit.mockReset();
    mocks.permit.mockResolvedValue({ error: null });
    // Reset, not just clear: a test that queues two answers must not
    // leak its second one into the next test.
    mocks.updateUserById.mockReset();
    mocks.updateUserById.mockResolvedValue({ error: null });
    mocks.readProfile.mockReset();
    mocks.readProfile.mockResolvedValue({ data: CURRENT, error: null });
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: 'user-2', email: CURRENT.email } },
      error: null,
    });
    mocks.updateProfiles.mockResolvedValue({
      data: [{ id: 'profile-2' }],
      error: null,
    });
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // 288: the login refuses a new email nobody asked a permit for.
  it('asks for a permit for the address before GoTrue, and only for an address', async () => {
    await PATCH(
      request({ full_name: 'Sara Ali', email: 'sara@new.example' }),
      params
    );
    expect(mocks.permit).toHaveBeenCalledExactlyOnceWith({
      p_user: 'user-2',
      p_email: 'sara@new.example',
    });
    expect(mocks.permit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUserById.mock.invocationCallOrder[0]
    );

    mocks.permit.mockClear();
    await PATCH(
      request({ full_name: 'Sara Khan', email: CURRENT.email }),
      params
    );
    expect(mocks.permit).not.toHaveBeenCalled();
  });

  it('asks for one to put the old address back', async () => {
    mocks.updateProfiles.mockResolvedValue({
      data: null,
      error: { message: 'down' },
    });
    await PATCH(
      request({ full_name: 'Sara Ali', email: 'sara@new.example' }),
      params
    );
    expect(mocks.permit.mock.calls.map(([a]) => a.p_email)).toEqual([
      'sara@new.example',
      CURRENT.email,
    ]);
  });

  it('carries on before 288, and says when a permit fails', async () => {
    mocks.permit.mockResolvedValueOnce({ error: { code: 'PGRST202' } });
    const body = { full_name: 'Sara Ali', email: 'sara@new.example' };
    expect((await PATCH(request(body), params)).status).toBe(200);
    expect(consoleError).not.toHaveBeenCalled();
    mocks.permit.mockResolvedValueOnce({ error: { code: '57014' } });
    await PATCH(request(body), params);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(mocks.updateUserById).toHaveBeenCalledTimes(2);
  });

  it('asks the database, then GoTrue, then profiles, then the audit row', async () => {
    const res = await PATCH(
      request({ full_name: '  Sara Khan ', email: ' Sara@New.Example ' }),
      params
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      member: {
        user_id: 'user-2',
        full_name: 'Sara Khan',
        email: 'sara@new.example',
      },
      changed: ['full_name', 'email'],
    });
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rpc).toHaveBeenCalledWith('authorize_member_details_change', {
      p_user_id: 'user-2',
    });
    expect(mocks.readProfile).toHaveBeenCalledWith({
      user_id: 'user-2',
      account_id: 'account-1',
    });
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-2', {
      email: 'sara@new.example',
      email_confirm: true,
    });
    expect(mocks.updateProfiles).toHaveBeenCalledWith(
      { full_name: 'Sara Khan', email: 'sara@new.example' },
      { user_id: 'user-2', email: 'sara@old.example' }
    );
    expect(mocks.adminRpc).toHaveBeenCalledWith('log_member_details_change', {
      p_actor_id: 'user-1',
      p_user_id: 'user-2',
      p_detail: {
        changed: ['full_name', 'email'],
        name_from: 'Sara Ali',
        name_to: 'Sara Khan',
        email_from: 'sara@old.example',
        email_to: 'sara@new.example',
      },
    });
    const order = [
      mocks.rpc,
      mocks.updateUserById,
      mocks.updateProfiles,
      mocks.adminRpc,
    ].map((m) => m.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each([
    ['missing', {}],
    ['a name that is not a string', { full_name: 5, email: 'a@b.co' }],
    ['an email that is not a string', { full_name: 'A', email: null }],
    ['a blank name', { full_name: '   ', email: 'a@b.co' }],
    [
      'a name over 120 characters',
      { full_name: 'x'.repeat(121), email: 'a@b.co' },
    ],
    ['a blank email', { full_name: 'A', email: ' ' }],
    ['an invalid email', { full_name: 'A', email: 'not-an-email' }],
    [
      'an email over 254 characters',
      { full_name: 'A', email: `${'a'.repeat(250)}@b.co` },
    ],
  ])('refuses %s, before asking anyone', async (_, body) => {
    const res = await PATCH(request(body), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.updateProfiles).not.toHaveBeenCalled();
  });

  it.each([
    [
      '42501',
      403,
      'You can edit the details only of people below your own role.',
    ],
    ['22023', 400, 'Change your own name and email in Settings → Profile.'],
  ])(
    'writes nothing when the database refuses (%s → %i)',
    async (code, status, message) => {
      mocks.rpc.mockResolvedValue({ error: { code, message } });
      const res = await PATCH(
        request({ full_name: 'Sara Khan', email: 'sara@new.example' }),
        params
      );
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: message });
      expect(mocks.updateUserById).not.toHaveBeenCalled();
      expect(mocks.updateProfiles).not.toHaveBeenCalled();
      expect(mocks.adminRpc).not.toHaveBeenCalled();
    }
  );

  it('answers 500 for an unexpected database error, writing nothing', async () => {
    mocks.rpc.mockResolvedValue({ error: { code: 'XX000', message: 'boom' } });
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(500);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.updateProfiles).not.toHaveBeenCalled();
  });

  it('writes nothing and logs nothing when nothing changed', async () => {
    const res = await PATCH(
      request({ full_name: ' Sara Ali ', email: 'SARA@old.example' }),
      params
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      member: {
        user_id: 'user-2',
        full_name: 'Sara Ali',
        email: 'sara@old.example',
      },
      changed: [],
    });
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.updateProfiles).not.toHaveBeenCalled();
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('changes only the name without asking GoTrue', async () => {
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@old.example' }),
      params
    );
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toEqual(['full_name']);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.updateProfiles).toHaveBeenCalledWith(
      { full_name: 'Sara Khan' },
      { user_id: 'user-2' }
    );
    expect(mocks.adminRpc).toHaveBeenCalledWith('log_member_details_change', {
      p_actor_id: 'user-1',
      p_user_id: 'user-2',
      p_detail: {
        changed: ['full_name'],
        name_from: 'Sara Ali',
        name_to: 'Sara Khan',
      },
    });
  });

  it('records only the email when only the email changed', async () => {
    await PATCH(
      request({ full_name: 'Sara Ali', email: 'sara@new.example' }),
      params
    );
    expect(mocks.adminRpc.mock.calls[0][1].p_detail).toEqual({
      changed: ['email'],
      email_from: 'sara@old.example',
      email_to: 'sara@new.example',
    });
  });

  it.each([
    [{ status: 422, code: 'email_exists', message: 'taken' }],
    [
      {
        status: 422,
        message: 'A user with this email address has already been registered',
      },
    ],
  ])(
    'answers 409 for a taken email, and writes no profile',
    async (authError) => {
      mocks.updateUserById.mockResolvedValue({ error: authError });
      const res = await PATCH(
        request({ full_name: 'Sara Khan', email: 'taken@example.com' }),
        params
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'That email is already used by another login.',
      });
      expect(mocks.updateProfiles).not.toHaveBeenCalled();
      expect(mocks.adminRpc).not.toHaveBeenCalled();
    }
  );

  it('answers 502 when GoTrue fails otherwise, never echoing its text', async () => {
    mocks.updateUserById.mockResolvedValue({
      error: {
        status: 500,
        code: 'unexpected_failure',
        message: 'secret-db-detail',
      },
    });
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('secret-db-detail');
    expect(mocks.updateProfiles).not.toHaveBeenCalled();
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('puts the old email back in GoTrue when the profiles write fails', async () => {
    mocks.updateProfiles.mockResolvedValue({
      error: { code: '42501', message: 'denied' },
    });
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not change the details. Nothing was changed; try again.',
    });
    expect(mocks.updateUserById).toHaveBeenCalledTimes(2);
    expect(mocks.updateUserById).toHaveBeenLastCalledWith('user-2', {
      email: 'sara@old.example',
      email_confirm: true,
    });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('logs a failed revert and still answers 502', async () => {
    mocks.updateProfiles.mockResolvedValue({ error: { code: 'XX000' } });
    mocks.updateUserById
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { status: 500, code: 'down' } });
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      'login and profile now disagree'
    );
  });

  it('does not touch GoTrue on a failed name-only profiles write', async () => {
    mocks.updateProfiles.mockResolvedValue({ error: { code: 'XX000' } });
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@old.example' }),
      params
    );
    expect(res.status).toBe(502);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('still answers ok when only the audit row fails: the change happened', async () => {
    mocks.adminRpc.mockResolvedValue({
      error: { code: '42501', message: 'denied' },
    });
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(consoleError).toHaveBeenCalled();
  });

  it('restores the login email, not a stale roster email, on a failed write', async () => {
    // The person changed their own login in Settings → Profile; the
    // roster still shows the old address.
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: 'user-2', email: 'sara@own-change.example' } },
      error: null,
    });
    mocks.updateProfiles.mockResolvedValue({ error: { code: 'XX000' } });
    const res = await PATCH(
      request({ full_name: 'Sara Ali', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(502);
    expect(mocks.updateUserById).toHaveBeenLastCalledWith('user-2', {
      email: 'sara@own-change.example',
      email_confirm: true,
    });
  });

  it('syncs the roster to the login without asking GoTrue', async () => {
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: 'user-2', email: 'sara@new.example' } },
      error: null,
    });
    const res = await PATCH(
      request({ full_name: 'Sara Ali', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toEqual(['email']);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.updateProfiles).toHaveBeenCalledWith(
      { email: 'sara@new.example' },
      { user_id: 'user-2', email: 'sara@old.example' }
    );
  });

  it('answers 502 and writes nothing when the login cannot be read', async () => {
    mocks.getUserById.mockResolvedValue({
      data: { user: null },
      error: { status: 500, code: 'down' },
    });
    const res = await PATCH(
      request({ full_name: 'Sara Khan', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(502);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.updateProfiles).not.toHaveBeenCalled();
  });

  it('answers 409 when another save changed the email first, matching the login to the roster', async () => {
    // The compare-and-set matched no row: another admin's save landed.
    mocks.updateProfiles.mockResolvedValue({ data: [], error: null });
    mocks.readProfile
      .mockResolvedValueOnce({ data: CURRENT, error: null })
      .mockResolvedValueOnce({
        data: { email: 'sara@other-admin.example' },
        error: null,
      });
    const res = await PATCH(
      request({ full_name: 'Sara Ali', email: 'sara@new.example' }),
      params
    );
    expect(res.status).toBe(409);
    expect(mocks.updateUserById).toHaveBeenLastCalledWith('user-2', {
      email: 'sara@other-admin.example',
      email_confirm: true,
    });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  describe('a form that showed old details', () => {
    const NEW = { full_name: 'Sara Ali', email: 'sara@new.example' };
    beforeEach(() => {
      mocks.readProfile.mockResolvedValue({ data: NEW, error: null });
      mocks.getUserById.mockResolvedValue({
        data: { user: { id: 'user-2', email: NEW.email } },
        error: null,
      });
    });
    const nothingWritten = () => {
      expect(mocks.permit).not.toHaveBeenCalled();
      expect(mocks.updateUserById).not.toHaveBeenCalled();
      expect(mocks.updateProfiles).not.toHaveBeenCalled();
      expect(mocks.adminRpc).not.toHaveBeenCalled();
    };

    it('changes a name alone and leaves the newer email', async () => {
      const res = await PATCH(
        rawRequest({
          full_name: 'Sara Khan',
          expected_full_name: 'Sara Ali',
        }),
        params
      );
      expect(res.status).toBe(200);
      expect((await res.json()).member).toEqual({
        user_id: 'user-2',
        full_name: 'Sara Khan',
        email: NEW.email,
      });
      expect(mocks.updateUserById).not.toHaveBeenCalled();
      expect(mocks.updateProfiles).toHaveBeenCalledWith(
        { full_name: 'Sara Khan' },
        { user_id: 'user-2' }
      );
    });

    it('never takes an untouched old email for an edit', async () => {
      const res = await PATCH(
        request({ full_name: 'Sara Khan', email: CURRENT.email }),
        params
      );
      expect((await res.json()).changed).toEqual(['full_name']);
      expect(mocks.updateUserById).not.toHaveBeenCalled();
    });

    it('refuses an older tab that would put the old email back', async () => {
      const res = await PATCH(
        rawRequest({ full_name: 'Sara Khan', email: CURRENT.email }),
        params
      );
      expect(res.status).toBe(409);
      nothingWritten();
    });

    it('still takes a name from an older tab whose email is current', async () => {
      const res = await PATCH(
        rawRequest({ full_name: 'Sara Khan', email: NEW.email }),
        params
      );
      expect((await res.json()).changed).toEqual(['full_name']);
      expect(mocks.updateUserById).not.toHaveBeenCalled();
    });

    it.each([
      ['email', { email: 'sara@third.example', expected_email: CURRENT.email }],
      ['name', { full_name: 'Sara Khan', expected_full_name: 'S. Ali' }],
    ])('answers 409 when the %s is no longer what it showed', async (_, b) => {
      const res = await PATCH(rawRequest(b), params);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/Someone else changed/);
      nothingWritten();
    });
  });
});
