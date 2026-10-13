import { beforeEach, describe, expect, it, vi } from 'vitest';

// Archiving authenticates with the session alone and judges the caller
// on their row in the workspace being archived, which need not be the
// active one (an archived workspace is restored from another).
// archive_workspace decides; the route only refuses a non-owner before
// calling it and words its refusals.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
  }),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'x' }, { status: 500 })),
}));

import { POST } from './route';

const T = '0b6f7c1e-2f43-4a8e-9d0a-5c1b2e3f4a5b';
const H = '6d0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function row(over: Record<string, unknown> = {}) {
  return {
    account_id: T,
    name: 'Taamul Credit',
    short_name: 'TC',
    role: 'owner',
    is_active: true,
    deactivated: false,
    archived: false,
    ...over,
  };
}

/** my_workspaces answers `rows`; archive_workspace answers `archive`. */
function rpcs(
  rows: unknown[],
  archive: { data?: unknown; error?: unknown } = {}
) {
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === 'my_workspaces'
      ? { data: rows, error: null }
      : { data: archive.data ?? null, error: archive.error ?? null }
  );
}

const RESULT = {
  account_id: T,
  archived: true,
  active_account_id: H,
  active_role: 'admin',
  moved: 4,
  invitations_revoked: 1,
};

describe('POST /api/workspaces/archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    rpcs([row(), row({ account_id: H, role: 'admin', is_active: false })], {
      data: RESULT,
    });
  });

  it('archives for an owner and says where the caller now is', async () => {
    const res = await POST(request({ accountId: T, archived: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accountId: T,
      archived: true,
      activeAccountId: H,
      activeRole: 'admin',
      moved: 4,
      invitationsRevoked: 1,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('archive_workspace', {
      p_account_id: T,
      p_archive: true,
    });
    expect(mocks.getCurrentAccount).not.toHaveBeenCalled();
    expect(mocks.requireRole).not.toHaveBeenCalled();
  });

  it('restores from another workspace, judged on the archived one', async () => {
    rpcs(
      [
        row({ account_id: H, role: 'agent', is_active: true }),
        row({ is_active: false, archived: true }),
      ],
      { data: { ...RESULT, archived: false, moved: 0, invitations_revoked: 0 } }
    );
    const res = await POST(request({ accountId: T, archived: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accountId: T, archived: false });
    expect(mocks.rpc).toHaveBeenCalledWith('archive_workspace', {
      p_account_id: T,
      p_archive: false,
    });
  });

  it.each([
    ['an admin there', [row({ role: 'admin' })]],
    ['a deactivated owner there', [row({ deactivated: true })]],
    ['not a member there', [row({ account_id: H })]],
    [
      'an owner of another workspace only',
      [row({ account_id: H }), row({ role: 'agent' })],
    ],
  ])(
    'refuses %s with 403 before calling archive_workspace',
    async (_, rows) => {
      rpcs(rows);
      const res = await POST(request({ accountId: T, archived: true }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Only an owner of that workspace can archive or restore it',
        code: 'forbidden',
      });
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        'archive_workspace',
        expect.anything()
      );
    }
  );

  it('words a refusal of archive_workspace, with its code and count', async () => {
    rpcs([row()], {
      error: { code: 'WS003', message: '2 member(s) have…', details: '2' },
    });
    const res = await POST(request({ accountId: T, archived: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        '2 members have no other workspace to move to. Deactivate or remove them first.',
      code: 'members_stranded',
      count: 2,
    });
  });

  it('keeps an unexpected database error generic', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpcs([row()], { error: { code: 'XX000', message: 'internal detail' } });
    const res = await POST(request({ accountId: T, archived: true }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Could not archive the workspace',
    });
    spy.mockRestore();
  });

  it('needs a session', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(request({ accountId: T, archived: true }));
    expect(res.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ accountId: 'not-a-uuid', archived: true }],
    [{ accountId: T }],
    [{ accountId: T, archived: 'true' }],
    [null],
  ])('rejects a malformed body %j', async (body) => {
    const res = await POST(request(body));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
