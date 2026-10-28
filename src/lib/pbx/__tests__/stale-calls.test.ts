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
  const from = (table: string) => {
    expect(table).toBe('calls');
    const f: Record<string, unknown> = {};
    let patch: Partial<Row> | null = null;
    const q = {
      select: () => q,
      in: (col: string, vals: string[]) => ((f[`in:${col}`] = vals), q),
      lt: (col: string, v: string) => ((f[`lt:${col}`] = v), q),
      eq: (col: string, v: string) => ((f[`eq:${col}`] = v), q),
      order: () => q,
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
  return { db: { from } as unknown as SupabaseClient, reads, updates };
}

function fakeOpen(records: Record<string, unknown>[], fail?: string) {
  const searches: { startTime: Date; endTime: Date }[] = [];
  const open = vi.fn(async () => {
    if (fail) throw new Error(fail);
    return {
      api: {
        searchCdr: vi.fn(async (input: { startTime: Date; endTime: Date }) => {
          searches.push(input);
          return { total: records.length, records };
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

  it('leaves a call with no CDR yet alone while it is younger than a day', async () => {
    rows = [row({ started_at: hoursAgo(5) })];
    const { db, updates } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([]).open,
    });
    expect(updates).toEqual([]);
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
    const { db, updates } = fakeDb(rows);
    const summary = await settleStaleCalls({
      db,
      now: () => NOW,
      open: fakeOpen([cdr('c-1'), cdr('c-2')]).open,
    });
    expect(updates).toEqual([]);
    expect(rows.map((r) => r.status)).toEqual(['answered', 'in_progress']);
    expect(summary).toMatchObject({ settled: 1, failed: 1, givenUp: 0 });
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
