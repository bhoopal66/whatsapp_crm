import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  admin: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: mocks.admin }));

import { PATCH } from './route';

const ID = '6f1c2a34-1b2c-4d5e-8f90-123456789abc';

/** Matches a row only when every filter equals the stored row. */
function fakeAdmin(row: Record<string, unknown> | null) {
  const filters: [string, unknown][] = [];
  let patch: Record<string, unknown> | null = null;
  const b: Record<string, unknown> = {};
  b.update = (v: Record<string, unknown>) => {
    patch = v;
    return b;
  };
  b.eq = (c: string, v: unknown) => {
    filters.push([c, v]);
    return b;
  };
  b.select = async () => ({
    data: row && filters.every(([c, v]) => row[c] === v) ? [{ id: ID }] : [],
    error: null,
  });
  return { admin: { from: () => b }, filters, getPatch: () => patch };
}

const mine = {
  id: ID,
  account_id: 'account-1',
  user_id: 'user-1',
  outcome: 'pending',
};

let fake: ReturnType<typeof fakeAdmin>;
function useRow(row: Record<string, unknown> | null) {
  fake = fakeAdmin(row);
  mocks.admin.mockReturnValue(fake.admin);
}

const patch = (body: unknown, id = ID) =>
  PATCH(
    new Request(`http://localhost/api/insights/compose-check/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({
    accountId: 'account-1',
    userId: 'user-1',
    role: 'agent',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useRow(mine);
});

describe('PATCH /api/insights/compose-check/[id]', () => {
  it('refuses a viewer (requires agent)', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await patch({ outcome: 'edited' })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('400 on a bad outcome or id', async () => {
    expect((await patch({ outcome: 'pending' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ outcome: 'edited' }, 'nope')).status).toBe(400);
  });

  it('records the outcome with the owner filters', async () => {
    const res = await patch({ outcome: 'sent_anyway' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.filters).toEqual([
      ['id', ID],
      ['account_id', 'account-1'],
      ['user_id', 'user-1'],
      ['outcome', 'pending'],
    ]);
    const written = fake.getPatch()!;
    expect(written.outcome).toBe('sent_anyway');
    expect(typeof written.decided_at).toBe('string');
  });

  it.each([
    ['another user', { ...mine, user_id: 'user-2' }],
    ['another account', { ...mine, account_id: 'account-2' }],
    ['an already decided event', { ...mine, outcome: 'edited' }],
    ['a missing event', null],
  ])('404 for %s', async (_n, row) => {
    useRow(row);
    const res = await patch({ outcome: 'edited' });
    expect(res.status).toBe(404);
  });
});
