import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET lists with the session alone (a deactivated active row must not
// hide the way out). POST creates a workspace, switches into it, and
// only THEN adds the invites: add_workspace_member targets the caller's
// active workspace, so inviting before the switch would fill the old one.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  sessionRpc: vi.fn(),
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  callerRpc: vi.fn(),
  adminRpc: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.sessionRpc,
  }),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: mocks.adminRpc,
    auth: {
      admin: {
        createUser: mocks.createUser,
        deleteUser: mocks.deleteUser,
        getUserById: mocks.getUserById,
        updateUserById: mocks.updateUserById,
      },
    },
  }),
}));

vi.mock('@/lib/supabase/urls', () => ({
  serverSupabaseUrl: () => 'http://localhost:8000',
}));

import { GET, POST } from './route';

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

describe('GET /api/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  });

  it('maps my_workspaces() to camelCase, with the session alone', async () => {
    mocks.sessionRpc.mockResolvedValue({
      data: [
        {
          account_id: 'a',
          name: 'Taamul Credit',
          short_name: 'TC',
          role: 'admin',
          is_active: true,
          deactivated: true,
        },
        {
          account_id: 'b',
          name: 'TrafeeqPay',
          short_name: 'TP',
          role: 'bank_guest',
          is_active: false,
          deactivated: false,
          archived: true,
        },
      ],
      error: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaces: [
        {
          accountId: 'a',
          name: 'Taamul Credit',
          shortName: 'TC',
          role: 'admin',
          isActive: true,
          deactivated: true,
          archived: false,
        },
        {
          accountId: 'b',
          name: 'TrafeeqPay',
          shortName: 'TP',
          role: 'bank_guest',
          isActive: false,
          deactivated: false,
          archived: true,
        },
      ],
    });
    expect(mocks.sessionRpc).toHaveBeenCalledWith('my_workspaces');
    expect(mocks.getCurrentAccount).not.toHaveBeenCalled();
    expect(mocks.requireRole).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
    expect(mocks.sessionRpc).not.toHaveBeenCalled();
  });

  it('answers 500 when the list cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.sessionRpc.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    expect((await GET()).status).toBe(500);
  });
});

describe('POST /api/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.callerRpc },
      accountId: 'old-ws',
      userId: 'user-1',
      role: 'admin',
    });
    mocks.callerRpc.mockImplementation(
      async (fn: string, args: { p_email?: string }) => {
        if (fn === 'create_workspace') return { data: 'new-ws', error: null };
        if (fn === 'switch_account') return { data: 'new-ws', error: null };
        if (args.p_email === 'ana@example.com')
          return { data: 'ana', error: null };
        if (args.p_email === 'dup@example.com') {
          return {
            data: null,
            error: {
              code: '23505',
              message: 'That person is already a member of this workspace',
            },
          };
        }
        return {
          data: null,
          error: { code: 'P0002', message: 'no_such_user' },
        };
      }
    );
    mocks.adminRpc.mockResolvedValue({ error: null });
    mocks.createUser.mockResolvedValue({
      data: { user: { id: 'gus' } },
      error: null,
    });
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: 'ana' } },
      error: null,
    });
  });

  it('creates, switches into the new workspace, then adds each invite there', async () => {
    const res = await POST(
      request({
        name: 'TrafeeqPay',
        shortName: 'TP',
        invites: [
          { email: 'ana@example.com', role: 'agent' },
          {
            email: 'gus@bank.example',
            role: 'bank_guest',
            bankCode: 'ENBD',
            password: 'correct-horse',
          },
          { email: 'dup@example.com', role: 'viewer' },
          { email: 'new@example.com', role: 'agent' },
        ],
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.accountId).toBe('new-ws');
    expect(body.invites).toEqual([
      { email: 'ana@example.com', ok: true },
      { email: 'gus@bank.example', ok: true },
      {
        email: 'dup@example.com',
        ok: false,
        error: 'That person is already a member of this workspace',
      },
      {
        email: 'new@example.com',
        ok: false,
        error: expect.stringMatching(/password/),
      },
    ]);

    const calls = mocks.callerRpc.mock.calls.map((c) => c[0]);
    expect(calls.slice(0, 3)).toEqual([
      'create_workspace',
      'switch_account',
      'add_workspace_member',
    ]);
    expect(mocks.callerRpc).toHaveBeenCalledWith('create_workspace', {
      p_name: 'TrafeeqPay',
      p_short_name: 'TP',
    });
    expect(mocks.callerRpc).toHaveBeenCalledWith('switch_account', {
      p_account_id: 'new-ws',
    });
    // A new login lands in the NEW workspace.
    expect(mocks.adminRpc).toHaveBeenCalledWith('provision_account_member', {
      p_user_id: 'gus',
      p_account_id: 'new-ws',
      p_role: 'bank_guest',
      p_bank_code: 'ENBD',
    });
  });

  it('needs an owner or admin of the active workspace', async () => {
    mocks.requireRole.mockRejectedValue(new Error('Insufficient role'));
    const res = await POST(request({ name: 'X', shortName: 'X' }));
    expect(res.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.callerRpc).not.toHaveBeenCalled();
  });

  it('rejects a malformed invite before creating anything', async () => {
    for (const invites of [
      {},
      [{ email: 'nope', role: 'agent' }],
      [{ email: 'a@b.c', role: 'owner' }],
    ]) {
      const res = await POST(request({ name: 'X', shortName: 'X', invites }));
      expect(res.status).toBe(400);
    }
    expect(mocks.callerRpc).not.toHaveBeenCalled();
  });

  it('passes the database’s refusal of a bad short name through as 400', async () => {
    mocks.callerRpc.mockResolvedValue({
      data: null,
      error: {
        code: '22023',
        message: 'Short name must be 1 to 4 letters or digits',
      },
    });
    const res = await POST(
      request({ name: 'TrafeeqPay', shortName: 'TOO-LONG' })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Short name must be 1 to 4 letters or digits',
    });
    expect(mocks.callerRpc).toHaveBeenCalledTimes(1);
  });

  it('adds nobody when the switch fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.callerRpc.mockImplementation(async (fn: string) =>
      fn === 'create_workspace'
        ? { data: 'new-ws', error: null }
        : { data: null, error: { code: 'XX000', message: 'boom' } }
    );
    const res = await POST(
      request({
        name: 'X',
        shortName: 'X',
        invites: [{ email: 'ana@example.com', role: 'agent' }],
      })
    );
    expect(res.status).toBe(500);
    expect((await res.json()).accountId).toBe('new-ws');
    expect(mocks.callerRpc).not.toHaveBeenCalledWith(
      'add_workspace_member',
      expect.anything()
    );
  });
});
