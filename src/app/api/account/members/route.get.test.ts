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

const personalCalls = {
  select: [] as unknown[][],
  eq: [] as unknown[][],
};

// Table-aware: `profiles` is recorded in `calls`, the personal-number
// read of `whatsapp_config` (migration 190) in `personalCalls`.
function ctx(
  result: { data?: Row[] | null; error?: unknown },
  personal: { data?: Row[] | null; error?: unknown } = { data: [] }
) {
  const builder: Record<string, unknown> = {
    select: (...args: unknown[]) => (calls.select.push(args), builder),
    eq: (...args: unknown[]) => (calls.eq.push(args), builder),
    order: () => Promise.resolve({ data: null, error: null, ...result }),
  };
  const personalBuilder: Record<string, unknown> = {
    select: (...args: unknown[]) => (
      personalCalls.select.push(args),
      personalBuilder
    ),
    eq: (...args: unknown[]) => (personalCalls.eq.push(args), personalBuilder),
    then: (resolve: (v: unknown) => unknown) =>
      resolve({ data: null, error: null, ...personal }),
  };
  return {
    supabase: {
      from: (table: string) =>
        table === 'whatsapp_config' ? personalBuilder : builder,
    },
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
    personalCalls.select.length = 0;
    personalCalls.eq.length = 0;
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

  it('carries the personal-WhatsApp flag and the personal number', async () => {
    mocks.requireRole.mockResolvedValue(
      ctx(
        {
          data: [
            { ...STAFF, may_connect_personal_whatsapp: true },
            { ...GUEST, user_id: 'bob', bank_code: null },
          ],
        },
        { data: [{ id: 'cfg-1', user_id: 'ana', waba_id: '971500000000' }] }
      )
    );

    const { members } = await (await GET()).json();

    expect(members[0]).toMatchObject({
      user_id: 'ana',
      may_connect_personal_whatsapp: true,
      personal_number: { id: 'cfg-1', phone: '971500000000' },
    });
    expect(members[1]).toMatchObject({
      may_connect_personal_whatsapp: false,
      personal_number: null,
    });
    expect(personalCalls.select).toEqual([['id, user_id, waba_id']]);
    expect(personalCalls.eq).toEqual([
      ['account_id', 'account-1'],
      ['is_personal', true],
    ]);
    // The profiles read is untouched by the second read.
    expect(calls.eq).toEqual([['account_id', 'account-1']]);
  });

  it('still lists members when the personal-number read fails', async () => {
    mocks.requireRole.mockResolvedValue(
      ctx({ data: [STAFF] }, { error: { message: 'no is_personal column' } })
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const { members } = await res.json();
    expect(members[0].personal_number).toBeNull();
    expect(members[0].may_connect_personal_whatsapp).toBe(false);
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
