import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../recordings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recordings')>()),
  fetchPendingRecordings: vi.fn(async () => ({
    fetched: 0,
    failed: 0,
    gaveUp: 0,
    skipped: 0,
    notStored: 0,
    busy: false,
  })),
}));
vi.mock('../callbacks', () => ({ dialDueCallbacks: vi.fn(async () => ({})) }));
vi.mock('../process', () => ({ processStoredPbxEvent: vi.fn() }));

import {
  ORPHAN_GRACE,
  ORPHAN_LIMIT,
  runPbxCron,
  sweepOrphanRecordings,
} from '../housekeeping';

function fakeDb(
  names: string[],
  opts: { rpcError?: string; failBatch?: number } = {}
) {
  const batches: string[][] = [];
  const rpc = vi.fn(async (fn: string) => {
    if (fn !== 'pbx_orphan_recordings') {
      return { data: { call_live: 0, events: 0 }, error: null };
    }
    return opts.rpcError
      ? { data: null, error: { message: opts.rpcError } }
      : { data: names, error: null };
  });
  const remove = vi.fn(async (batch: string[]) => {
    batches.push(batch);
    return batches.length === opts.failBatch
      ? { data: null, error: { message: 'storage unavailable' } }
      : { data: batch.map((name) => ({ name })), error: null };
  });
  const from = vi.fn(() => ({ remove }));
  const query: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'not', 'lt', 'order']) {
    query[m] = () => query;
  }
  query.limit = async () => ({ data: [], error: null });
  const db = { rpc, storage: { from }, from: () => query };
  return { db: db as unknown as SupabaseClient, rpc, from, batches };
}

const names = (count: number) =>
  Array.from({ length: count }, (_, i) => `account-a/calls/${i}.wav`);

describe('sweepOrphanRecordings', () => {
  it('lists past the grace window and removes in bounded batches', async () => {
    const f = fakeDb(names(250));
    const out = await sweepOrphanRecordings({ db: f.db });
    expect(f.rpc).toHaveBeenCalledWith('pbx_orphan_recordings', {
      p_older_than: ORPHAN_GRACE,
      p_limit: ORPHAN_LIMIT,
    });
    expect(f.from).toHaveBeenCalledWith('call-recordings');
    expect(f.batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(f.batches.flat()).toEqual(names(250));
    expect(out).toEqual({ found: 250, deleted: 250, failed: 0 });
  });

  it('counts a failed batch and still removes the others', async () => {
    const f = fakeDb(names(250), { failBatch: 2 });
    const out = await sweepOrphanRecordings({ db: f.db });
    expect(f.batches).toHaveLength(3);
    expect(out).toEqual({
      found: 250,
      deleted: 150,
      failed: 100,
      error: 'storage unavailable',
    });
  });

  it('starts no batch after the deadline', async () => {
    const f = fakeDb(names(250));
    let t = 0;
    const out = await sweepOrphanRecordings({
      db: f.db,
      deadline: 2,
      now: () => t++,
    });
    expect(out).toEqual({ found: 250, deleted: 200, failed: 0 });
  });

  it('throws when the list cannot be read', async () => {
    const f = fakeDb([], { rpcError: 'permission denied' });
    await expect(sweepOrphanRecordings({ db: f.db })).rejects.toThrow(
      'pbx_orphan_recordings failed: permission denied'
    );
  });
});

describe('runPbxCron', () => {
  it('sweeps orphaned audio after the purge and reports the counts', async () => {
    const f = fakeDb(names(3));
    const out = await runPbxCron({ db: f.db });
    expect(f.rpc.mock.calls.map((c) => c[0])).toEqual([
      'pbx_purge',
      'pbx_orphan_recordings',
    ]);
    expect(out.orphans).toEqual({ found: 3, deleted: 3, failed: 0 });
    expect(out.errors).toEqual({});
  });

  it('records a failed remove as the step error, counts kept', async () => {
    const f = fakeDb(names(3), { failBatch: 1 });
    const out = await runPbxCron({ db: f.db });
    expect(out.orphans).toMatchObject({ found: 3, deleted: 0, failed: 3 });
    expect(out.errors.orphans).toBe(
      '3 orphaned recording(s) not removed: storage unavailable'
    );
  });
});
