import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

type Call = { op: string; args: unknown[] };

/** Every query records its calls; count depends on outcome / code filter. */
function fakeDb(error: { message: string } | null = null) {
  const queries: Call[][] = [];
  const from = () => {
    const calls: Call[] = [];
    queries.push(calls);
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'gte', 'contains']) {
      b[op] = (...args: unknown[]) => {
        calls.push({ op, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void) => {
      const outcome = calls.find(
        (c) => c.op === 'eq' && c.args[0] === 'outcome'
      )?.args[1];
      const code = calls.find((c) => c.op === 'contains')?.args[1] as
        string[] | undefined;
      const count = code
        ? code[0] === 'promise'
          ? 4
          : 1
        : outcome === 'sent_anyway'
          ? 3
          : outcome === 'edited'
            ? 2
            : outcome === 'pending'
              ? 1
              : 6;
      resolve({ count, error });
    };
    return b;
  };
  return { db: { from }, queries };
}

let fake: ReturnType<typeof fakeDb>;
function useDb(role = 'admin', error: { message: string } | null = null) {
  fake = fakeDb(error);
  mocks.requireRole.mockResolvedValue({
    supabase: fake.db,
    accountId: 'account-1',
    userId: 'user-1',
    role,
  });
}

const get = (qs = '') =>
  GET(new Request(`http://localhost/api/insights/compose-check/stats${qs}`));

beforeEach(() => {
  mocks.requireRole.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useDb();
});

describe('GET /api/insights/compose-check/stats', () => {
  it('is admin only', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await get()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it.each(['0', '91', '-1', '2.5', 'abc'])('400 on days=%s', async (d) => {
    expect((await get(`?days=${d}`)).status).toBe(400);
  });

  it.each([
    ['', 7],
    ['?days=1', 1],
    ['?days=90', 90],
  ])('accepts %s as %d days, windowed by created_at', async (qs, days) => {
    const before = Date.now();
    const res = await get(qs);
    expect(res.status).toBe(200);
    expect((await res.json()).days).toBe(days);
    const gte = fake.queries[0].find((c) => c.op === 'gte')!;
    const since = Date.parse(gte.args[1] as string);
    expect(gte.args[0]).toBe('created_at');
    expect(Math.abs(before - days * 86_400_000 - since)).toBeLessThan(5000);
  });

  it('answers the counts with head queries', async () => {
    const json = await (await get()).json();
    expect(json).toEqual({
      days: 7,
      total: 6,
      sentAnyway: 3,
      edited: 2,
      pending: 1,
      byCode: {
        promise: 4,
        terms: 1,
        non_partner_bank: 1,
        regulator_claim: 1,
        secrets: 1,
        tone: 1,
        cold_pitch: 1,
      },
    });
    for (const q of fake.queries) {
      expect(q[0]).toEqual({
        op: 'select',
        args: ['id', { count: 'exact', head: true }],
      });
      expect(q).toContainEqual({ op: 'eq', args: ['account_id', 'account-1'] });
    }
  });

  it('500 when a count fails', async () => {
    useDb('admin', { message: 'boom' });
    expect((await get()).status).toBe(500);
  });
});
