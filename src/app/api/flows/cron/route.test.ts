import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const OLD = '2026-01-01T00:00:00.000Z';
const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  orders: [] as string[],
  onRead: null as null | (() => void),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: ((r: Row) => boolean)[] = [];
      let patch: Row | null = null;
      let range: [number, number] | null = null;
      const b: Row = {
        select: () => b,
        insert: async () => ({ error: null }),
        order: (c: string) => (h.orders.push(c), b),
        range: (f: number, t: number) => ((range = [f, t]), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        update: (row: Row) => ((patch = row), b),
        then: (ok: (r: unknown) => unknown) => {
          const hit =
            table === 'flow_runs'
              ? h.rows.filter((r) => filters.every((f) => f(r)))
              : [];
          if (patch) hit.forEach((r) => Object.assign(r, patch));
          // PostgREST answers at most two rows here.
          const from = range?.[0] ?? 0;
          const data = patch ? hit : hit.slice(from, from + 2);
          const copy = data.map((r) => ({ ...r }));
          if (!patch && copy.length === 0) h.onRead?.();
          return Promise.resolve({ data: copy, error: null }).then(ok);
        },
      };
      return b;
    },
  }),
}));

import { GET } from './route';

const sweep = () =>
  GET(
    new Request('http://x/api/flows/cron', {
      headers: { 'x-cron-secret': 's3cret' },
    })
  ).then((r) => r.json());

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 's3cret';
  h.orders = [];
  h.onRead = null;
  h.rows = ['1', '2', '3', '4', '5'].map((id) => ({
    id,
    status: 'active',
    last_advanced_at: OLD,
    flows: { fallback_policy: null },
  }));
});

describe('GET /api/flows/cron', () => {
  it('sweeps past one page, oldest first', async () => {
    expect(await sweep()).toEqual({ swept: 5 });
    expect(h.orders.slice(0, 2)).toEqual(['last_advanced_at', 'id']);
  });

  it('keeps the run of a customer who answers during the sweep', async () => {
    h.onRead = () => {
      h.rows[0].last_advanced_at = new Date().toISOString();
    };
    expect(await sweep()).toEqual({ swept: 4 });
    expect(h.rows[0].status).toBe('active');
  });
});
