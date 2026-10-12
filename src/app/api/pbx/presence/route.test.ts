import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { GET } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
let rls: FakeDb;

function as(role: AccountRole) {
  mocks.requireRole.mockImplementation(async (min: AccountRole) => {
    if (!hasMinRole(role, min)) throw new Error('Insufficient role');
    return { accountId: A, userId: 'me', role, supabase: rls.db };
  });
}
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const row = (user_id: string, p: object) => ({
  connection_id: 'conn-1',
  extension: '201',
  account_id: A,
  user_id,
  presence: 'available',
  call_state: 'idle',
  updated_at: ago(1),
  ...p,
});

beforeEach(() => {
  vi.clearAllMocks();
  rls = createFakeDb({
    pbx_presence: [
      row('u-free', {}),
      row('u-call', { extension: '202', call_state: 'busy' }),
      row('u-lunch', { extension: '203', presence: 'lunch' }),
      row('u-dnd', { extension: '204', presence: 'do_not_disturb' }),
      row('u-home', { extension: '205', presence: 'off_work' }),
      row('u-stale', { extension: '206', updated_at: ago(11) }),
      row('u-other', { extension: '207', account_id: 'elsewhere' }),
      row('', { extension: '208', user_id: null }),
    ],
  });
  as('viewer');
});

describe('GET /api/pbx/presence', () => {
  it('maps each person’s state for the active workspace', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    const body = (await res.json()) as Record<string, { state: string }>;
    expect(
      Object.fromEntries(Object.entries(body).map(([u, p]) => [u, p.state]))
    ).toEqual({
      'u-free': 'available',
      'u-call': 'on_call',
      'u-lunch': 'away',
      'u-dnd': 'dnd',
      'u-home': 'off_work',
      'u-stale': 'offline',
    });
    expect(body['u-call']).toEqual({
      state: 'on_call',
      extension: '202',
      updatedAt: rls.tables.pbx_presence[1].updated_at,
    });
  });

  it('refuses a bank guest', async () => {
    as('bank_guest');
    expect((await GET()).status).toBe(403);
    expect(rls.log).toEqual([]);
  });
});
