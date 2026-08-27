import { beforeEach, describe, expect, it, vi } from 'vitest';

// Admin-created members replace self-service signup, so this route is
// the only door into the CRM. Its guards are the whole security story:
// who may create a login, what role they may hand out, and what
// happens to a half-created user when the move into the account fails.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 }),
  ),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser } },
    rpc: mocks.rpc,
  }),
}));

vi.mock('@/lib/supabase/urls', () => ({
  serverSupabaseUrl: () => 'http://localhost:8000',
}));

import { POST } from './route';

const ADMIN_CTX = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

const VALID = {
  email: 'New.Person@Example.com ',
  full_name: 'New Person',
  password: 'correct-horse',
  role: 'agent',
};

describe('POST /api/account/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'user-2' } }, error: null });
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.deleteUser.mockResolvedValue({ error: null });
  });

  it('creates a confirmed login and moves it into the caller’s account', async () => {
    const res = await POST(request(VALID));
    expect(res.status).toBe(201);

    // Confirmed up front: this deployment sends no mail, so waiting on
    // a verification link would lock the new user out for good.
    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new.person@example.com', email_confirm: true }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith('provision_account_member', {
      p_user_id: 'user-2',
      p_account_id: 'account-1',
      p_role: 'agent',
    });
  });

  it('requires the admin role', async () => {
    mocks.requireRole.mockRejectedValue(new Error('Insufficient role'));
    const res = await POST(request(VALID));
    expect(res.status).toBe(403);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('refuses to mint a second owner', async () => {
    // An account has exactly one owner; a second is created by
    // transferring ownership, not by provisioning a member.
    const res = await POST(request({ ...VALID, role: 'owner' }));
    expect(res.status).toBe(400);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('rejects a short password before calling the provider', async () => {
    const res = await POST(request({ ...VALID, password: 'short' }));
    expect(res.status).toBe(400);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed email', async () => {
    const res = await POST(request({ ...VALID, email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('reports a taken address as a conflict', async () => {
    mocks.createUser.mockResolvedValue({
      data: null,
      error: { message: 'A user with this email address has already been registered' },
    });
    const res = await POST(request(VALID));
    expect(res.status).toBe(409);
  });

  it('deletes the auth user when the move into the account fails', async () => {
    // Otherwise the login exists but sits in a private account nobody
    // can see — and its email is now taken, so the admin cannot retry.
    mocks.rpc.mockResolvedValue({ error: { message: 'boom' } });

    const res = await POST(request(VALID));

    expect(res.status).toBe(500);
    expect(mocks.deleteUser).toHaveBeenCalledWith('user-2');
  });
});
