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
const silence = vi.hoisted(() => ({
  calls: [] as string[],
  run: async () => ({ alerted: 1, restored: 0 }),
}));
vi.mock('../health', () => ({
  checkPbxSilence: vi.fn(async () => {
    silence.calls.push('silence');
    return silence.run();
  }),
}));

import {
  expireRecordings,
  ORPHAN_GRACE,
  ORPHAN_LIMIT,
  OUTCOME_REMINDER_LIMIT,
  RETENTION_BATCH,
  RETENTION_ROUNDS,
  runPbxCron,
  sweepOrphanRecordings,
} from '../housekeeping';

function fakeDb(
  names: string[],
  opts: {
    rpcError?: string;
    failBatch?: number;
    keepaliveError?: string;
    remindError?: string;
    expired?: string[][];
  } = {}
) {
  const batches: string[][] = [];
  const expired = [...(opts.expired ?? [])];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'pbx_presence_keepalive') {
      return opts.keepaliveError
        ? { data: null, error: { message: opts.keepaliveError } }
        : { data: 2, error: null };
    }
    if (fn === 'pbx_outcome_reminders') {
      return opts.remindError
        ? { data: null, error: { message: opts.remindError } }
        : { data: 2, error: null };
    }
    if (fn === 'pbx_expire_recordings') {
      return opts.rpcError
        ? { data: null, error: { message: opts.rpcError } }
        : { data: expired.shift() ?? [], error: null };
    }
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
      'pbx_presence_keepalive',
      'pbx_outcome_reminders',
      'pbx_purge',
      'pbx_expire_recordings',
      'pbx_orphan_recordings',
    ]);
    expect(out.orphans).toEqual({ found: 3, deleted: 3, failed: 0 });
    expect(out.errors).toEqual({});
  });

  it('first refreshes the presence of people still on a live call', async () => {
    const f = fakeDb([]);
    const out = await runPbxCron({ db: f.db });
    expect(f.rpc.mock.calls[0]).toEqual(['pbx_presence_keepalive']);
    expect(out.presence).toBe(2);
    expect(out.errors).toEqual({});
  });

  it('records a failed keepalive and runs the other steps', async () => {
    const f = fakeDb(names(1), { keepaliveError: 'boom' });
    const out = await runPbxCron({ db: f.db });
    expect(out.errors).toEqual({ presence: 'boom' });
    expect(out.orphans).toEqual({ found: 1, deleted: 1, failed: 0 });
  });

  it('rings the outcome reminders next, a bounded batch per run', async () => {
    const f = fakeDb([]);
    const out = await runPbxCron({ db: f.db });
    expect(f.rpc.mock.calls.slice(0, 2)).toEqual([
      ['pbx_presence_keepalive'],
      ['pbx_outcome_reminders', { p_limit: OUTCOME_REMINDER_LIMIT }],
    ]);
    expect(out.outcomeReminders).toBe(2);
  });

  it('runs the silence alert after the reminders, before any download', async () => {
    const f = fakeDb([]);
    silence.calls = [];
    const order: string[] = [];
    f.rpc.mockImplementation(async (name: string) => {
      order.push(name);
      return { data: 2, error: null };
    });
    silence.run = async () => {
      order.push('silence');
      return { alerted: 1, restored: 0 };
    };
    const out = await runPbxCron({ db: f.db });
    expect(order.slice(0, 3)).toEqual([
      'pbx_presence_keepalive',
      'pbx_outcome_reminders',
      'silence',
    ]);
    expect(out.silence).toEqual({ alerted: 1, restored: 0 });
    silence.run = async () => {
      throw new Error('read failed');
    };
    const failed = await runPbxCron({ db: fakeDb([]).db });
    expect(failed.errors.silence).toBe('read failed');
    silence.run = async () => ({ alerted: 1, restored: 0 });
  });

  it('records a failed reminder sweep and runs the other steps', async () => {
    const f = fakeDb(names(1), { remindError: 'db down' });
    const out = await runPbxCron({ db: f.db });
    expect(out.errors.outcomes).toBe('db down');
    expect(out.outcomeReminders).toBeUndefined();
    expect(out.orphans).toEqual({ found: 1, deleted: 1, failed: 0 });
  });

  it('starts no reminder sweep once the budget is spent', async () => {
    const f = fakeDb([]);
    const out = await runPbxCron({ db: f.db, budgetMs: 0 });
    expect(out.outOfTime.slice(0, 3)).toEqual([
      'presence',
      'outcomes',
      'silence',
    ]);
    expect(f.rpc).not.toHaveBeenCalled();
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

describe('expireRecordings', () => {
  const paths = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => `account-a/calls/r${from + i}.wav`);

  it('removes the audio of every recording the batch marked erased', async () => {
    const f = fakeDb([], { expired: [paths(150)] });
    const out = await expireRecordings({ db: f.db });
    expect(f.rpc).toHaveBeenCalledWith('pbx_expire_recordings', {
      p_limit: RETENTION_BATCH,
    });
    expect(f.from).toHaveBeenCalledWith('call-recordings');
    expect(f.batches.map((b) => b.length)).toEqual([100, 50]);
    expect(out).toEqual({ expired: 150, deleted: 150, failed: 0 });
  });

  it('takes another batch while one comes back full, at most RETENTION_ROUNDS', async () => {
    const full = Array.from({ length: RETENTION_ROUNDS + 1 }, (_, k) =>
      paths(RETENTION_BATCH, k * RETENTION_BATCH)
    );
    const f = fakeDb([], { expired: full });
    const out = await expireRecordings({ db: f.db });
    expect(f.rpc).toHaveBeenCalledTimes(RETENTION_ROUNDS);
    expect(out.expired).toBe(RETENTION_ROUNDS * RETENTION_BATCH);
  });

  it('stops after a short batch, and starts none after the deadline', async () => {
    const f = fakeDb([], { expired: [paths(3), paths(3)] });
    expect(await expireRecordings({ db: f.db })).toMatchObject({ expired: 3 });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    const g = fakeDb([], { expired: [paths(3)] });
    const out = await expireRecordings({ db: g.db, deadline: 0, now: () => 1 });
    expect(g.rpc).not.toHaveBeenCalled();
    expect(out).toEqual({ expired: 0, deleted: 0, failed: 0 });
  });

  it('ends the run at a failed remove: the rest is left for the orphan sweep', async () => {
    const f = fakeDb([], {
      failBatch: 1,
      expired: [paths(RETENTION_BATCH), paths(3)],
    });
    const out = await expireRecordings({ db: f.db });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      expired: RETENTION_BATCH,
      deleted: 0,
      failed: RETENTION_BATCH,
      error: 'storage unavailable',
    });
  });

  it('throws when the batch cannot be marked', async () => {
    const f = fakeDb([], { rpcError: 'permission denied' });
    await expect(expireRecordings({ db: f.db })).rejects.toThrow(
      'pbx_expire_recordings failed: permission denied'
    );
  });

  it('runs before the orphan sweep and reports a failed remove as its error', async () => {
    const f = fakeDb([], { failBatch: 1, expired: [paths(2)] });
    const out = await runPbxCron({ db: f.db });
    expect(out.retention).toMatchObject({ expired: 2, failed: 2 });
    expect(out.errors.retention).toBe(
      '2 expired recording(s) not removed: storage unavailable'
    );
    expect(f.rpc.mock.calls.map((c) => c[0]).slice(-2)).toEqual([
      'pbx_expire_recordings',
      'pbx_orphan_recordings',
    ]);
  });
});
