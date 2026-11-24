import { beforeEach, describe, expect, it, vi } from 'vitest';

// A privacy form saved over a version it was not loaded from must be
// refused: the save replaces the whole row, and `apply` deletes customer
// data.
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ userId: 'u1', accountId: 'a1' }),
  toErrorResponse: () => Response.json({ error: 'x' }, { status: 403 }),
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { PUT as putBasis } from './ai-transfer/route';
import { PUT as putRetention } from './retention/route';

const AT = '2026-11-01T08:00:00.000000+00:00';
let stored: unknown;

const CASES = [
  {
    name: 'ai-transfer',
    put: putBasis,
    setFn: 'ai_transfer_basis_set',
    body: { basis: null, requireBasis: false },
    row: { basis: { basis: 'scc', recorded_at: AT } },
    none: { basis: null },
  },
  {
    name: 'retention',
    put: putRetention,
    setFn: 'privacy_retention_set',
    body: { policy: { tables: {} }, apply: true },
    row: { policy: { tables: {} }, apply: false, updated_at: AT },
    none: { policy: { tables: {} }, apply: false, updated_at: null },
  },
];

beforeEach(() => {
  m.rpc.mockReset();
  m.rpc.mockImplementation(async () => ({ data: stored, error: null }));
});

describe.each(CASES)('$name PUT', ({ put, setFn, body, row, none }) => {
  const save = (extra: object) =>
    put(
      new Request('http://x', {
        method: 'PUT',
        body: JSON.stringify({ ...body, ...extra }),
      })
    );
  const written = () => m.rpc.mock.calls.some(([fn]) => fn === setFn);

  it.each([
    ['an older version', { expectedUpdatedAt: '2026-10-01T00:00:00+00:00' }],
    ['a form loaded when there was none', { expectedUpdatedAt: null }],
    ['no version at all', {}],
  ])('%s: 409 and nothing written', async (_n, extra) => {
    stored = row;
    const res = await save(extra);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STALE' });
    expect(written()).toBe(false);
  });

  it('the version it was loaded from: saved', async () => {
    stored = row;
    expect((await save({ expectedUpdatedAt: AT })).status).toBe(200);
    expect(written()).toBe(true);
  });

  it('the first save: saved', async () => {
    stored = none;
    expect((await save({ expectedUpdatedAt: null })).status).toBe(200);
    expect(written()).toBe(true);
  });
});
