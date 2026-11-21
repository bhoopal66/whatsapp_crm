import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { POST } from './route';

const U = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown) =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-1',
    salesRestricted: false,
  });
});

describe('POST /api/desk/leave', () => {
  it('records leave as the caller in the active account', async () => {
    m.rpc.mockResolvedValue({ data: 'leave-1', error: null });
    const res = await POST(
      post({
        userId: U,
        firstDay: '2026-11-24',
        lastDay: '2026-11-28',
        note: 'annual',
      })
    );
    expect(await res.json()).toEqual({ id: 'leave-1' });
    expect(m.rpc).toHaveBeenCalledWith(
      'desk_leave_add',
      expect.objectContaining({
        p_actor: 'u-1',
        p_account: 'acc-1',
        p_user: U,
        p_first: '2026-11-24',
        p_last: '2026-11-28',
      })
    );
  });

  it('refuses a malformed day before the database', async () => {
    for (const firstDay of ['24/11/2026', '2026-13-40', null]) {
      const res = await POST(
        post({ userId: U, firstDay, lastDay: '2026-11-28' })
      );
      expect(res.status).toBe(400);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('maps NOT_ALLOWED from the SQL', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'NOT_ALLOWED', message: 'x' },
    });
    const res = await POST(
      post({ userId: U, firstDay: '2026-11-24', lastDay: '2026-11-24' })
    );
    expect(res.status).toBe(403);
  });
});
