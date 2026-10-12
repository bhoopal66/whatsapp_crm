import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET hands the Members tab every membership of the active workspace.
// Guests are INCLUDED on purpose (an admin has to see and manage them);
// the staff pickers drop them client-side with `staffOnly`. Since
// migration 083 the row also says which bank a guest belongs to, and the
// read must still answer on a database that has no `bank_code` yet.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: vi.fn(),
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

type Row = Record<string, unknown>;

const calls = {
  select: [] as unknown[][],
  eq: [] as unknown[][],
};

function ctx(result: { data?: Row[] | null; error?: unknown }) {
  const builder: Record<string, unknown> = {
    select: (...args: unknown[]) => (calls.select.push(args), builder),
    eq: (...args: unknown[]) => (calls.eq.push(args), builder),
    order: () => Promise.resolve({ data: null, error: null, ...result }),
  };
  return {
    supabase: { from: () => builder },
    accountId: 'account-1',
    role: 'admin',
  };
}

const STAFF = {
  user_id: 'ana',
  full_name: 'Ana',
  email: 'ana@example.com',
  avatar_url: null,
  account_role: 'agent',
  created_at: '2026-01-01T00:00:00Z',
  deactivated_at: null,
  bank_code: null,
};

const GUEST = {
  ...STAFF,
  user_id: 'gus',
  full_name: 'Gus',
  email: 'gus@bank.example',
  account_role: 'bank_guest',
  bank_code: 'ENBD',
};

describe('GET /api/account/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.select.length = 0;
    calls.eq.length = 0;
  });

  it("lists the bank's code on a guest and null on staff", async () => {
    mocks.requireRole.mockResolvedValue(ctx({ data: [STAFF, GUEST] }));

    const res = await GET();
    expect(res.status).toBe(200);
    const { members } = await res.json();

    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(members).toEqual([
      expect.objectContaining({
        user_id: 'ana',
        role: 'agent',
        email: 'ana@example.com',
        bank_code: null,
      }),
      expect.objectContaining({
        user_id: 'gus',
        role: 'bank_guest',
        bank_code: 'ENBD',
      }),
    ]);
  });

  it('reads the active workspace only', async () => {
    mocks.requireRole.mockResolvedValue(ctx({ data: [STAFF] }));

    await GET();

    // RLS also returns the caller's own row in every other workspace.
    expect(calls.eq).toEqual([['account_id', 'account-1']]);
  });

  it('answers a database without bank_code, with null', async () => {
    // No 083 yet: the row has no such column at all, and the select must
    // not name it (that would fail the whole read).
    const { bank_code: _absent, ...preMigration } = STAFF;
    void _absent;
    mocks.requireRole.mockResolvedValue(ctx({ data: [preMigration] }));

    const res = await GET();
    expect(res.status).toBe(200);
    const { members } = await res.json();

    expect(members[0].bank_code).toBeNull();
    expect(calls.select).toEqual([['*']]);
  });

  it('fails the whole list when the roster cannot be read', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.requireRole.mockResolvedValue(ctx({ error: { message: 'boom' } }));

    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load members' });
    consoleError.mockRestore();
  });
});
