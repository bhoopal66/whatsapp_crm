import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/broadcasts/[id]/reply-classes: counts through the caller's
// RLS client, plus the switch and Jev's availability.

type Filters = [string, string, unknown][];

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  broadcast: { id: 'b' } as unknown,
  /** count for a head query, by its filters */
  count: (() => 0) as (f: Filters) => number,
  queries: [] as { table: string; filters: Filters; head: boolean }[],
  settings: { replyClassEnabled: true },
  available: true,
}));

function fakeSupabase() {
  return {
    from(table: string) {
      const q = { table, filters: [] as Filters, head: false };
      h.queries.push(q);
      const b: Record<string, unknown> = {
        select: (_c: string, opts?: { head?: boolean }) => {
          q.head = Boolean(opts?.head);
          return b;
        },
        maybeSingle: async () => ({ data: h.broadcast, error: null }),
        then: (res: (r: unknown) => unknown) =>
          Promise.resolve({ count: h.count(q.filters), error: null }).then(res),
      };
      for (const f of ['eq', 'is'])
        b[f] = (c: string, v: unknown) => {
          q.filters.push([f, c, v]);
          return b;
        };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/insights/settings', () => ({
  getInsightSettings: async () => h.settings,
  insightsAvailable: () => h.available,
}));

import { GET } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const get = (id = ID) =>
  GET(new Request(`http://localhost/api/broadcasts/${id}/reply-classes`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  h.queries = [];
  h.broadcast = { id: ID };
  h.settings = { replyClassEnabled: true };
  h.available = true;
  h.requireRole.mockReset().mockResolvedValue({
    supabase: fakeSupabase(),
    accountId: 'acct-1',
    userId: 'u-1',
    role: 'admin',
  });
  h.count = (f) => {
    const cls = f.find(([, c]) => c === 'reply_class');
    if (cls?.[0] === 'eq') return cls[2] === 'interested' ? 4 : 1;
    if (cls?.[0] === 'is') return 9;
    return 0;
  };
});

describe('GET /api/broadcasts/[id]/reply-classes', () => {
  it('answers the counts per class, the unclassified replies and the switches', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      counts: {
        interested: 4,
        question: 1,
        not_now: 1,
        not_interested: 1,
        wrong_person: 1,
        stop: 1,
        other: 1,
      },
      unclassifiedReplies: 9,
      enabled: true,
      available: true,
    });
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    const unclassified = h.queries.find((q) =>
      q.filters.some(([f]) => f === 'is')
    )!;
    expect(unclassified.head).toBe(true);
    expect(unclassified.filters).toEqual([
      ['eq', 'broadcast_id', ID],
      ['eq', 'status', 'replied'],
      ['is', 'reply_class', null],
    ]);
    expect(h.queries[0]!.filters).toContainEqual([
      'eq',
      'account_id',
      'acct-1',
    ]);
  });

  it('reports the feature off and Jev unavailable', async () => {
    h.settings = { replyClassEnabled: false };
    h.available = false;
    expect(await (await get()).json()).toMatchObject({
      enabled: false,
      available: false,
    });
  });

  it('404s a broadcast the caller cannot read, 400s a bad id', async () => {
    h.broadcast = null;
    expect((await get()).status).toBe(404);
    expect((await get('nope')).status).toBe(400);
  });

  it('refuses a caller below admin', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await get()).status).toBe(403);
  });
});
