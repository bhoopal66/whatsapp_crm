import { beforeEach, describe, expect, it, vi } from 'vitest';

// Who may list, mint and revoke invite links (migration 175): owners and
// admins only; a team leader is refused like an agent. RLS holds the
// same rule; this pins the routes' own check.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  insert: vi.fn(),
  single: vi.fn(),
  select: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { DELETE } from './[id]/route';
import { GET, POST } from './route';

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

  it.each(['team_leader', 'agent', 'viewer', 'bank_guest'])(
    'refuses a %s caller on every role',
    async (role) => {
      mocks.getCurrentAccount.mockResolvedValue(ctx(role));
      for (const invited of ['agent', 'viewer', 'admin']) {
        const res = await POST(request({ role: invited }));
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(
          'Inviting people requires the admin role or higher'
        );
      }
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

describe('GET /api/account/invitations', () => {
  it.each(['team_leader', 'agent', 'viewer', 'bank_guest'])(
    'refuses a %s caller before reading',
    async (role) => {
      mocks.getCurrentAccount.mockResolvedValue({
        ...ctx(role),
        supabase: {
          from: () => {
            mocks.select();
            return {};
          },
        },
      });
      const res = await GET();
      expect(res.status).toBe(403);
      expect(mocks.select).not.toHaveBeenCalled();
    }
  );
});

describe('DELETE /api/account/invitations/[id]', () => {
  const params = { params: Promise.resolve({ id: 'inv-1' }) };
  const del = () =>
    DELETE(
      new Request('https://crm.example/api/account/invitations/inv-1'),
      params
    );

  it.each(['team_leader', 'agent', 'viewer', 'bank_guest'])(
    'refuses a %s caller before deleting',
    async (role) => {
      mocks.getCurrentAccount.mockResolvedValue({
        ...ctx(role),
        supabase: {
          from: () => {
            mocks.del();
            return {};
          },
        },
      });
      const res = await del();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(
        'Revoking invitations requires the admin role or higher'
      );
      expect(mocks.del).not.toHaveBeenCalled();
    }
  );
});
