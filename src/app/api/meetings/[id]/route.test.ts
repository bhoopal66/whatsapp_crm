import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH writes the invitee change before the meeting itself, so a
// refused invitee (23514: not a live staff member) leaves the title and
// the current invitee list untouched.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  writes: [] as string[],
  insertError: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { PATCH } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const OLD = '44444444-4444-4444-8444-444444444444';
const NEW = '55555555-5555-4555-8555-555555555555';
const params = { params: Promise.resolve({ id: M }) };

function from(table: string) {
  const q: Record<string, unknown> = {};
  let op = 'select';
  for (const m of ['select', 'eq', 'in']) q[m] = () => q;
  q.update = () => ((op = 'update'), mocks.writes.push('update'), q);
  q.delete = () => ((op = 'delete'), mocks.writes.push('delete'), q);
  q.insert = async () => (
    mocks.writes.push('insert'),
    { error: mocks.insertError }
  );
  q.maybeSingle = async () => ({
    data: { id: M, account_id: 'acct-1', status: 'scheduled', title: 'T' },
    error: null,
  });
  q.then = (resolve: (v: unknown) => void) =>
    resolve(
      table === 'meeting_invitees' && op === 'select'
        ? { data: [{ user_id: OLD }], error: null }
        : { error: null }
    );
  return q;
}

const patch = () =>
  PATCH(
    new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed', inviteeUserIds: [NEW] }),
    }),
    params
  );

describe('PATCH /api/meetings/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writes = [];
    mocks.insertError = null;
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: {
        from,
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      },
    });
  });

  it('adds, then removes, then updates the meeting', async () => {
    expect((await patch()).status).toBe(200);
    expect(mocks.writes).toEqual(['insert', 'delete', 'update']);
  });

  it('changes nothing else when an invitee is refused', async () => {
    mocks.insertError = { code: '23514', message: 'Only a live staff member' };
    expect((await patch()).status).toBe(400);
    expect(mocks.writes).toEqual(['insert']);
  });
});
