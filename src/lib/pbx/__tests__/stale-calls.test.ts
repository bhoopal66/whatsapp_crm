import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PbxHandle } from '../connection';

// The ingest is the call-end path itself (process.test.ts covers it):
// here it settles the fake row the way writeCallEnd would.
const ingest = vi.hoisted(() => ({
  calls: [] as { payload: unknown; historical?: boolean }[],
  fail: new Set<string>(),
  onIngest: (() => {}) as (callId: string) => void,
}));
vi.mock('../process', () => ({
  ingestPbxEvent: vi.fn(
    async (input: {
      payload: { msg: { call_id: string } };
      historical?: boolean;
    }) => {
      ingest.calls.push(input);
      const id = input.payload.msg.call_id;
      if (ingest.fail.has(id)) return { duplicate: false, error: 'boom' };
      ingest.onIngest(id);
      return { duplicate: false, kind: 'call_end' };
    }
  ),
}));

import {
  onceEvery,
  settleStaleCalls,
  STALE_CALL_BATCH,
  STALE_MAX_PAGES,
  UNSETTLED_META_KEY,
} from '../stale-calls';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

interface Row {
  id: string;
  connection_id: string;
  pbx_call_id: string;
  status: string;
  started_at: string;
  meta: Record<string, unknown> | null;
}

/** Just the calls queries the step makes, over an in-memory table. */
function fakeDb(rows: Row[]) {
  const reads: Record<string, unknown>[] = [];
  const updates: { id: string; patch: Row }[] = [];
  const orders: unknown[][] = [];
  const liveDeletes: string[] = [];
  const from = (table: string) => {
    if (table === 'call_live') {
      const f: Record<string, string> = {};
      const d = {
        delete: () => d,
        eq: (col: string, v: string) => ((f[col] = v), d),
        then: (resolve: (v: unknown) => void) => {
          expect(f.connection_id).toBe('conn-1');
          liveDeletes.push(f.pbx_call_id);
          resolve({ error: null });
        },
      };
      return d;
    }
    expect(table).toBe('calls');
    const f: Record<string, unknown> = {};
    let patch: Partial<Row> | null = null;
    const q = {
      select: () => q,
      in: (col: string, vals: string[]) => ((f[`in:${col}`] = vals), q),
      lt: (col: string, v: string) => ((f[`lt:${col}`] = v), q),
      eq: (col: string, v: string) => ((f[`eq:${col}`] = v), q),
      order: (...args: unknown[]) => (orders.push(args), q),
      update: (p: Partial<Row>) => ((patch = p), q),
      limit: (n: number) => ((f.limit = n), q),
      then: (resolve: (v: unknown) => void) => {
        const hit = rows.filter((r) =>
          Object.entries(f).every(([k, v]) => {
            const [op, col] = k.split(':');
            const cell = (r as unknown as Record<string, string>)[col];
            if (op === 'in') return (v as string[]).includes(cell);
            if (op === 'eq') return cell === v;
            if (op === 'lt') return cell < (v as string);
            return true;
          })
        );
        if (patch) {
          for (const r of hit) {
            Object.assign(r, patch);
            updates.push({ id: r.id, patch: { ...r } });
          }
        } else reads.push(f);
        const limited =
          typeof f.limit === 'number' ? hit.slice(0, f.limit) : hit;
        resolve({ data: limited.map((r) => ({ ...r })), error: null });
      },
    };
    return q;
  };
  return {
    db: { from } as unknown as SupabaseClient,
    reads,
    updates,
    orders,
    liveDeletes,
  };
}

interface Search {
  startTime: Date;
  endTime: Date;
  page: number;
  pageSize: number;
}

/**
 * The PBX's CDR search: `records` as one page by default. `fullPages`
 * answers every page with a full page of unrelated records (a busy PBX)
 * and `total` overrides the count the PBX reports.
 */
function fakeOpen(
  records: Record<string, unknown>[],
  fail?: string,
  opts: {
    fullPages?: boolean;
    total?: number;
    onSearch?: (s: Search) => void;
  } = {}
) {
  const searches: Search[] = [];
  const open = vi.fn(async () => {
    if (fail) throw new Error(fail);
    return {
      api: {
        searchCdr: vi.fn(async (input: Search) => {
          searches.push(input);
          opts.onSearch?.(input);
          const page = opts.fullPages
            ? Array.from({ length: input.pageSize }, (_, i) =>
                cdr(`other-${input.page}-${i}`)
              )
            : records;
          return { total: opts.total ?? records.length, records: page };
        }),
      },
    } as unknown as PbxHandle;
  });
  return { open, searches };
}

const row = (o: Partial<Row>): Row => ({
  id: 'r-1',
  connection_id: 'conn-1',
  pbx_call_id: 'c-1',
  status: 'in_progress',
  started_at: hoursAgo(3),
  meta: { rang_user_ids: ['u'] },
  ...o,
});
const cdr = (callId: string) => ({
  uid: `u-${callId}`,
  call_id: callId,
  call_type: 'Inbound',
  call_from_number: '0501234567',
  call_to_number: '1001',
  timestamp: Math.floor(NOW / 1000) - 3 * 3600,
  duration: 120,
  talk_duration: 100,
  disposition: 'ANSWERED',
  record_file: 'a.wav',
});

describe('settleStaleCalls', () => {
  let rows: Row[];
  beforeEach(() => {
    ingest.calls.length = 0;
    ingest.fail.clear();
    ingest.onIngest = (id) => {
      for (const r of rows) if (r.pbx_call_id === id) r.status = 'answered';
    };
  });

  it('reads live calls older than two hours, a bounded batch, oldest first', async () => {
    rows = [];
    const { db, reads } = fakeDb(rows);
    const { open } = fakeOpen([]);
    await settleStaleCalls({ db, now: () => NOW, open });
    expect(reads[0]).toMatchObject({
      'in:status': ['ringing', 'in_progress'],
      'lt:started_at': hoursAgo(2),
      limit: STALE_CALL_BATCH,
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('ingests the matching CDR in historical mode and counts the call settled', async () => {
    rows = [
      row({}),
      row({ id: 'r-2', pbx_call_id: 'c-2', status: 'ringing' }),
      // Still within two hours: left alone.
      row({ id: 'r-3', pbx_call_id: 'c-3', started_at: hoursAgo(1) }),
    ];
    const { db } = fakeDb(rows);
    // The window also returns calls the CRM settled long ago, and c-3.
    const { open, searches } = fakeOpen([
      cdr('c-1'),
      cdr('c-1'),
      cdr('c-2'),
      cdr('other'),
      cdr('c-3'),
    ]);
    const summary = await settleStaleCalls({ db, now: () => NOW, open });
    expect(ingest.calls.map((c) => c.historical)).toEqual([true, true]);
    expect(
      ingest.calls.map(
        (c) => (c.payload as { type: number; msg: { call_id: string } }).msg
      )
    ).toMatchObject([
      { call_id: 'c-1', recording: 'a.wav', status: 'ANSWERED' },
      { call_id: 'c-2' },
    ]);
    expect(summary).toMatchObject({
      found: 2,
      ingested: 2,
      settled: 2,
      givenUp: 0,
      failed: 0,
    });
    // The window brackets the calls' starts, padded, never past now.
    expect(searches[0].startTime.getTime()).toBeLessThan(
      Date.parse(hoursAgo(3))
    );
    expect(searches[0].endTime.getTime()).toBeLessThanOrEqual(NOW);
    expect(rows[2].status).toBe('in_progress');
  });

  it('leaves a call with no CDR yet live while it is younger than a day, stamped checked', async () => {
    rows = [row({ started_at: hoursAgo(5) })];
    const { db, liveDeletes } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([]).open,
    });
    expect(rows[0]).toMatchObject({
      status: 'in_progress',
      meta: {
        rang_user_ids: ['u'],
        stale_checked_at: new Date(NOW).toISOString(),
      },
    });
    expect(rows[0].meta).not.toHaveProperty(UNSETTLED_META_KEY);
    expect(liveDeletes).toEqual([]);
    expect(summary).toMatchObject({ found: 1, settled: 0, givenUp: 0 });
  });

  it('after a day with no CDR, settles it and marks meta so it is not retried', async () => {
    rows = [
      row({ started_at: hoursAgo(30) }),
      row({
        id: 'r-2',
        pbx_call_id: 'c-2',
        status: 'ringing',
        started_at: hoursAgo(29),
      }),
    ];
    const { db } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([]).open,
    });
    expect(summary).toMatchObject({ givenUp: 2, settled: 0 });
    expect(rows[0]).toMatchObject({
      status: 'answered',
      meta: {
        rang_user_ids: ['u'],
        [UNSETTLED_META_KEY]: { was: 'in_progress' },
      },
    });
    expect(rows[1]).toMatchObject({
      status: 'failed',
      meta: { [UNSETTLED_META_KEY]: { was: 'ringing' } },
    });
  });

  it('never gives up on a call the CDR just settled, nor on one whose ingest failed', async () => {
    rows = [
      row({ started_at: hoursAgo(30) }),
      row({ id: 'r-2', pbx_call_id: 'c-2', started_at: hoursAgo(30) }),
    ];
    ingest.fail.add('c-2');
    const { db, liveDeletes } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([cdr('c-1'), cdr('c-2')]).open,
    });
    expect(rows.map((r) => r.status)).toEqual(['answered', 'in_progress']);
    expect(rows[1].meta).toMatchObject({ stale_ingest_failures: 1 });
    expect(rows[1].meta).not.toHaveProperty(UNSETTLED_META_KEY);
    expect(summary).toMatchObject({ settled: 1, failed: 1, givenUp: 0 });
    // The settled call's screen pop goes; the live one's stays.
    expect(liveDeletes).toEqual(['c-1']);
  });

  it('clears the screen pop of a call it gave up on, and of no other', async () => {
    rows = [
      row({ started_at: hoursAgo(30) }),
      row({ id: 'r-2', pbx_call_id: 'c-2', started_at: hoursAgo(5) }),
    ];
    const { db, liveDeletes } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([]).open,
    });
    expect(summary.givenUp).toBe(1);
    expect(liveDeletes).toEqual(['c-1']);
  });

  it('gives nothing up when the budget runs out mid-paging', async () => {
    rows = [row({ started_at: hoursAgo(30) })];
    const { db, liveDeletes } = fakeDb(rows);
    let t = NOW;
    const { open, searches } = fakeOpen([], undefined, {
      fullPages: true,
      total: 5_000,
      // The first page eats the rest of the budget.
      onSearch: () => (t = NOW + 1_000),
    });
    const summary = await settleStaleCalls({
      db,
      now: () => t,
      deadline: NOW + 1_000,
      open,
    });
    expect(searches).toHaveLength(1);
    expect(rows[0].status).toBe('in_progress');
    expect(summary.givenUp).toBe(0);
    expect(liveDeletes).toEqual([]);
  });

  it('gives nothing up when paging stops at the page cap', async () => {
    rows = [row({ started_at: hoursAgo(30) })];
    const { db } = fakeDb(rows);
    const { open, searches } = fakeOpen([], undefined, {
      fullPages: true,
      total: 50_000,
    });
    const summary = await settleStaleCalls({ db, now: () => NOW, open });
    expect(searches.map((s) => s.page)).toEqual(
      Array.from({ length: STALE_MAX_PAGES }, (_, i) => i + 1)
    );
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].meta).toHaveProperty('stale_checked_at');
    expect(summary.givenUp).toBe(0);
  });

  it('gives nothing up when the PBX reports more records than it returned', async () => {
    rows = [row({ started_at: hoursAgo(30) })];
    const { db } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([cdr('other')], undefined, { total: 3 }).open,
    });
    expect(rows[0].status).toBe('in_progress');
    expect(summary.givenUp).toBe(0);
  });

  it('puts calls checked before at the back of the batch', async () => {
    rows = [];
    const { db, orders } = fakeDb(rows);
    await settleStaleCalls({ db, now: () => NOW, open: fakeOpen([]).open });
    expect(orders).toEqual([
      ['meta->>stale_checked_at', { ascending: true, nullsFirst: true }],
      ['started_at', { ascending: true }],
    ]);
  });

  it('gives up a day-old call whose ingest keeps failing, once the failures reach the cap', async () => {
    rows = [
      row({
        started_at: hoursAgo(30),
        meta: { stale_ingest_failures: 4, stale_checked_at: hoursAgo(1) },
      }),
      row({
        id: 'r-2',
        pbx_call_id: 'c-2',
        started_at: hoursAgo(30),
        meta: { stale_ingest_failures: 1 },
      }),
    ];
    ingest.fail.add('c-1');
    ingest.fail.add('c-2');
    const { db, liveDeletes } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([cdr('c-1'), cdr('c-2')]).open,
    });
    expect(summary).toMatchObject({ failed: 2, givenUp: 1 });
    expect(rows[0]).toMatchObject({
      status: 'answered',
      meta: {
        [UNSETTLED_META_KEY]: { was: 'in_progress', ingest_failures: 5 },
      },
    });
    expect(rows[0].meta).not.toHaveProperty('stale_ingest_failures');
    expect(rows[0].meta).not.toHaveProperty('stale_checked_at');
    expect(rows[1]).toMatchObject({
      status: 'in_progress',
      meta: { stale_ingest_failures: 2 },
    });
    expect(liveDeletes).toEqual(['c-1']);
  });

  it('gives up on nothing when the PBX cannot be read', async () => {
    rows = [row({ started_at: hoursAgo(30) })];
    const { db, updates } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([], 'PBX unreachable').open,
    });
    expect(updates).toEqual([]);
    expect(summary.errors).toEqual({ 'conn-1': 'PBX unreachable' });
  });

  it('starts nothing once the deadline has passed', async () => {
    rows = [row({ started_at: hoursAgo(30) })];
    const { db, updates } = fakeDb(rows);
    const { open } = fakeOpen([cdr('c-1')]);
    await settleStaleCalls({ db, now: () => NOW, deadline: NOW, open });
    expect(open).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe('onceEvery', () => {
  it('passes once per interval', () => {
    const due = onceEvery(15 * 60_000);
    expect(due(0)).toBe(true);
    expect(due(14 * 60_000)).toBe(false);
    expect(due(15 * 60_000)).toBe(true);
  });
});
