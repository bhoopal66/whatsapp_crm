import { beforeEach, describe, expect, it, vi } from 'vitest';

// Switching authenticates with the session alone: a person whose active
// workspace deactivated them is refused by getCurrentAccount, and moving
// to another workspace is exactly what they need. switch_account decides.

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

const WS = '0b6f7c1e-2f43-4a8e-9d0a-5c1b2e3f4a5b';

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

describe('POST /api/workspaces/switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mocks.rpc.mockResolvedValue({ data: WS, error: null });
  });

  it('switches with the session alone, even from a deactivated workspace', async () => {
    const res = await POST(request({ accountId: WS }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: WS });
    expect(mocks.rpc).toHaveBeenCalledWith('switch_account', {
      p_account_id: WS,
    });
    expect(mocks.getCurrentAccount).not.toHaveBeenCalled();
    expect(mocks.requireRole).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(request({ accountId: WS }));
    expect(res.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects something that is not a workspace id', async () => {
    const res = await POST(request({ accountId: 'nope' }));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('passes the refusal through when the caller is not active there', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'You are not an active member of that workspace',
      },
    });
    const res = await POST(request({ accountId: WS }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You are not an active member of that workspace',
    });
  });
});
