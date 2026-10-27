import { beforeEach, describe, expect, it, vi } from 'vitest';

// Setting another member's password takes over their login, so the
// order is what these tests pin: the database decides first
// (authorize_member_password_change, migration 140, as the caller), and
// GoTrue is asked only after it said yes. The audit row comes last and
// cannot undo the change. The password must never reach a log.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  adminRpc: vi.fn(),
  updateUserById: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { admin: { updateUserById: mocks.updateUserById } },
    rpc: mocks.adminRpc,
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

import { POST } from './route';

const ADMIN_CTX = {
  supabase: { rpc: mocks.rpc },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

const PASSWORD = 'Correct-Horse-9';

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

const params = { params: Promise.resolve({ userId: 'user-2' }) };

describe('POST /api/account/members/[userId]/password', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ADMIN_CTX);
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.adminRpc.mockResolvedValue({ error: null });
    mocks.updateUserById.mockResolvedValue({ error: null });
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function loggedText(): string {
    return JSON.stringify(consoleError.mock.calls);
  }

  it('asks the database, then GoTrue, then writes the audit row', async () => {
    const res = await POST(request({ password: PASSWORD }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rpc).toHaveBeenCalledWith('authorize_member_password_change', {
      p_user_id: 'user-2',
    });
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-2', {
      password: PASSWORD,
    });
    // No workspace of the caller's choosing: the function writes a row
    // in every workspace the person belongs to.
    expect(mocks.adminRpc).toHaveBeenCalledWith('log_member_password_change', {
      p_actor_id: 'user-1',
      p_user_id: 'user-2',
    });
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUserById.mock.invocationCallOrder[0]
    );
    expect(mocks.updateUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.adminRpc.mock.invocationCallOrder[0]
    );
  });

  it.each([
    ['missing', {}],
    ['not a string', { password: 12345678 }],
    ['empty', { password: '' }],
    ['too short', { password: 'short7!' }],
    ['over 72 bytes', { password: 'é'.repeat(37) }],
  ])('refuses a password that is %s, before asking anyone', async (_, body) => {
    const res = await POST(request(body), params);
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it.each([
    [
      '42501',
      403,
      'You can change the password only of people below your own role.',
    ],
    ['22023', 400, 'Change your own password in Settings → Login & security.'],
  ])(
    'never calls GoTrue when the database refuses (%s → %i)',
    async (code, status, message) => {
      mocks.rpc.mockResolvedValue({ error: { code, message } });
      const res = await POST(request({ password: PASSWORD }), params);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: message });
      expect(mocks.updateUserById).not.toHaveBeenCalled();
      expect(mocks.adminRpc).not.toHaveBeenCalled();
    }
  );

  it('answers 500 for an unexpected database error, without GoTrue', async () => {
    mocks.rpc.mockResolvedValue({
      error: { code: 'XX000', message: 'internal' },
    });
    const res = await POST(request({ password: PASSWORD }), params);
    expect(res.status).toBe(500);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 422, code: 'weak_password', message: 'weak' }],
    [{ status: 422, code: 'same_password', message: 'same' }],
    [{ status: 422, message: 'Password should be at least 8 characters' }],
  ])('turns a password GoTrue refuses into a 400', async (authError) => {
    mocks.updateUserById.mockResolvedValue({ error: authError });
    const res = await POST(request({ password: PASSWORD }), params);
    expect(res.status).toBe(400);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('answers 502 when GoTrue fails otherwise, and logs no audit row', async () => {
    mocks.updateUserById.mockResolvedValue({
      error: { status: 500, code: 'unexpected_failure', message: 'down' },
    });
    const res = await POST(request({ password: PASSWORD }), params);
    expect(res.status).toBe(502);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('still answers ok when only the audit row fails: the change happened', async () => {
    mocks.adminRpc.mockResolvedValue({
      error: { code: '42501', message: 'denied' },
    });
    const res = await POST(request({ password: PASSWORD }), params);
    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalled();
  });

  it('never writes the password to a log, on any path', async () => {
    mocks.updateUserById.mockResolvedValue({
      error: { status: 500, code: 'unexpected_failure', message: 'down' },
    });
    await POST(request({ password: PASSWORD }), params);
    mocks.updateUserById.mockResolvedValue({ error: null });
    mocks.adminRpc.mockResolvedValue({ error: { code: 'x', message: 'y' } });
    await POST(request({ password: PASSWORD }), params);
    mocks.rpc.mockResolvedValue({ error: { code: 'XX000', message: 'z' } });
    await POST(request({ password: PASSWORD }), params);
    expect(consoleError).toHaveBeenCalled();
    expect(loggedText()).not.toContain(PASSWORD);
  });
});
