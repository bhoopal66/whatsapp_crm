import { beforeEach, describe, expect, it, vi } from 'vitest';

type Filter = [string, string, unknown];
type Query = { table: string; columns: string; filters: Filter[] };
type Answer = { data?: unknown; count?: number; error?: unknown };

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  queries: [] as Query[],
  tables: {} as Record<string, (q: Query) => Answer>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    requireRole: async (min: Parameters<typeof real.requireRole>[0]) => {
      if (!hasMinRole(m.ctx.role as typeof min, min))
        throw new real.ForbiddenError('Insufficient role');
      return m.ctx;
    },
  };
});
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const q: Query = { table, columns: '', filters: [] };
      const add = (op: string) => (k: string, v: unknown) => (
        q.filters.push([op, k, v]),
        b
      );
      const b = {
        select: (c: string) => ((q.columns = c), b),
        eq: add('eq'),
        in: add('in'),
        gte: add('gte'),
        is: add('is'),
        not: (k: string, op: string, v: unknown) => (
          q.filters.push([`not.${op}`, k, v]),
          b
        ),
        order: () => b,
        limit: () => b,
        then: (ok: (v: unknown) => unknown) => {
          m.queries.push(q);
          const r = m.tables[table]!(q);
          return Promise.resolve({
            data: r.data ?? null,
            count: r.count ?? null,
            error: r.error ?? null,
          }).then(ok);
        },
      };
      return b;
    },
  }),
}));

import { GET } from './route';

const has = (q: Query, op: string, k: string) =>
  q.filters.some(([o, key]) => o === op && key === k);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role: 'admin' };
  m.queries = [];
  m.tables = {
    submission_groups: () => ({
      data: [
        {
          id: 'g-1',
          submission_ref: 'SUB-1',
          status: 'ACTIVE',
          submission_status: 'Pending With Bank - Credit Review',
          created_at: '2026-10-20T08:00:00Z',
          ended_at: null,
          contact_id: 'c-1',
        },
        {
          id: 'g-2',
          submission_ref: 'SUB-2',
          status: 'ENDED',
          submission_status: null,
          created_at: '2026-10-19T08:00:00Z',
          ended_at: '2026-10-20T09:00:00Z',
          contact_id: null,
        },
      ],
    }),
    cases: () => ({
      data: [
        {
          id: 'case-1',
          group_id: 'g-1',
          stage: 'Submitted',
          bank_code: 'ADCB',
          external_changed_at: '2026-10-20T10:00:00Z',
        },
      ],
    }),
    contacts: () => ({ data: [{ id: 'c-1', name: 'Sara' }] }),
    webhook_event_outbox: (q) => ({
      count: q.filters.some(
        ([o, k, v]) => o === 'eq' && k === 'event' && v === 'case.stage_changed'
      )
        ? has(q, 'is', 'delivered_at')
          ? 2
          : 5
        : 0,
    }),
  };
});

describe('GET /api/compass/submissions', () => {
  it('refuses anyone below admin', async () => {
    m.ctx.role = 'team_leader';
    expect((await GET()).status).toBe(403);
    expect(m.queries).toEqual([]);
  });

  it("filters every read by the caller's active account", async () => {
    expect((await GET()).status).toBe(200);
    expect(m.queries.length).toBeGreaterThan(3);
    for (const q of m.queries)
      expect(q.filters, q.table).toContainEqual(['eq', 'account_id', 'acct-1']);
    const cases = m.queries.find((q) => q.table === 'cases')!;
    expect(cases.filters).toContainEqual(['in', 'group_id', ['g-1', 'g-2']]);
    const contacts = m.queries.find((q) => q.table === 'contacts')!;
    expect(contacts.filters).toContainEqual(['in', 'id', ['c-1']]);
    for (const q of m.queries.filter((x) => x.table === 'webhook_event_outbox'))
      expect(has(q, 'gte', 'created_at')).toBe(true);
  });

  it('joins groups to their case and contact and counts the outbox', async () => {
    const body = await (await GET()).json();
    expect(body.submissions).toEqual([
      {
        submissionRef: 'SUB-1',
        status: 'ACTIVE',
        submissionStatus: 'Pending With Bank - Credit Review',
        createdAt: '2026-10-20T08:00:00Z',
        endedAt: null,
        customer: 'Sara',
        caseId: 'case-1',
        stage: 'Submitted',
        bankCode: 'ADCB',
        externalChangedAt: '2026-10-20T10:00:00Z',
      },
      {
        submissionRef: 'SUB-2',
        status: 'ENDED',
        submissionStatus: null,
        createdAt: '2026-10-19T08:00:00Z',
        endedAt: '2026-10-20T09:00:00Z',
        customer: null,
        caseId: null,
        stage: null,
        bankCode: null,
        externalChangedAt: null,
      },
    ]);
    expect(body.webhooks).toContainEqual({
      event: 'case.stage_changed',
      delivered: 5,
      pending: 2,
    });
    expect(body.webhooks).toContainEqual({
      event: 'contact.opted_out',
      delivered: 0,
      pending: 0,
    });
  });

  it('answers 500 when a read fails', async () => {
    m.tables.cases = () => ({ error: { message: 'boom' } });
    expect((await GET()).status).toBe(500);
  });
});
