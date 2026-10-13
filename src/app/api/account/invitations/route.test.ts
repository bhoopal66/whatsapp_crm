import { beforeEach, describe, expect, it, vi } from 'vitest';

// Who may mint an invite link, and with which role (migration 099):
// owner/admin any staff role, a team leader agent or viewer only. RLS
// holds the same rule; this pins the route's own check.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  insert: vi.fn(),
  single: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { POST } from './route';

const insertQuery = {
  select: () => insertQuery,
  single: mocks.single,
};

function ctx(role: string) {
  return {
    supabase: {
      from: () => ({
        insert: (row: unknown) => {
          mocks.insert(row);
          return insertQuery;
        },
      }),
    },
    accountId: 'account-1',
    // A fresh user per test keeps the per-user rate limit out of the way.
    userId: `user-${Math.random()}`,
    role,
  };
}

function request(body: unknown): Request {
  return new Request('https://crm.example/api/account/invitations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example');
    mocks.single.mockResolvedValue({
      data: { id: 'inv-1', role: 'agent' },
      error: null,
    });
  });

  it.each(['agent', 'viewer'])(
    'lets a team leader invite a %s',
    async (role) => {
      mocks.getCurrentAccount.mockResolvedValue(ctx('team_leader'));
      const res = await POST(request({ role }));
      expect(res.status).toBe(201);
      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ role, account_id: 'account-1' })
      );
    }
  );

  it.each(['admin', 'team_leader', 'bank_guest'])(
    'refuses a team leader inviting a %s',
    async (role) => {
      mocks.getCurrentAccount.mockResolvedValue(ctx('team_leader'));
      const res = await POST(request({ role }));
      expect(res.status).toBe(403);
      expect(mocks.insert).not.toHaveBeenCalled();
    }
  );

  it.each(['agent', 'viewer', 'bank_guest'])(
    'refuses a %s caller',
    async (role) => {
      mocks.getCurrentAccount.mockResolvedValue(ctx(role));
      const res = await POST(request({ role: 'agent' }));
      expect(res.status).toBe(403);
      expect(mocks.insert).not.toHaveBeenCalled();
    }
  );

  it('lets an admin invite an admin', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx('admin'));
    const res = await POST(request({ role: 'admin' }));
    expect(res.status).toBe(201);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' })
    );
  });
});
