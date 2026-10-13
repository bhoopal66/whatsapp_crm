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

let rls: FakeDb;

function as(role: AccountRole) {
  mocks.requireRole.mockImplementation(async (min: AccountRole) => {
    if (!hasMinRole(role, min)) throw new Error('Insufficient role');
    return { accountId: 'acc', userId: 'me', role, supabase: rls.db };
  });
}
const get = (query: string) =>
  GET(new Request(`http://x/api/pbx/settings/retention${query}`));
const rpcs = () => rls.log.filter((l) => l.op === 'rpc');

beforeEach(() => {
  vi.clearAllMocks();
  rls = createFakeDb(
    {},
    { pbx_retention_due: () => ({ data: 12, error: null }) }
  );
});

describe('GET /api/pbx/settings/retention', () => {
  it("counts on the caller's own session what the period would delete", async () => {
    as('admin');
    const res = await get('?days=30');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ days: 30, due: 12 });
    expect(rpcs()).toEqual([
      { table: 'rpc:pbx_retention_due', op: 'rpc', payload: { p_days: 30 } },
    ]);
  });

  it('is an admin’s, and asks nothing for a bad period', async () => {
    as('team_leader');
    expect((await get('?days=30')).status).toBe(403);
    as('admin');
    for (const q of ['', '?days=', '?days=0', '?days=3651', '?days=1.5']) {
      expect((await get(q)).status).toBe(400);
    }
    expect(rpcs()).toEqual([]);
  });

  it("passes on the function's own refusal", async () => {
    as('admin');
    rls.rpcs.pbx_retention_due = () => ({
      data: null,
      error: { code: '42501', message: 'Only an owner or admin' },
    });
    expect((await get('?days=30')).status).toBe(403);
  });
});
