import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const gw = vi.hoisted(() => ({
  logoutSession: vi.fn(),
  deleteSession: vi.fn(),
  findScopedKeyIds: vi.fn(),
  revokeKey: vi.fn(),
}));

// Real OpenWAError and env reader; gateway calls stubbed.
vi.mock('./openwa-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gw,
}));

import { OpenWAError } from './openwa-api';
import {
  OPENWA_ABANDONED_AFTER_MS,
  sweepAbandonedOpenWASessions,
} from './openwa-cleanup';

type Call = [string, unknown[]];

/** Records every chained call per query; answers by operation. */
function fakeAdmin(opts: {
  abandoned: Array<Record<string, unknown>>;
  rest?: Array<Record<string, unknown>>;
}) {
  const queries: Call[][] = [];
  const db = {
    from() {
      const calls: Call[] = [];
      queries.push(calls);
      const b: Record<string, unknown> = {};
      for (const m of [
        'select',
        'delete',
        'update',
        'eq',
        'is',
        'lt',
        'order',
        'limit',
      ]) {
        b[m] = (...args: unknown[]) => {
          calls.push([m, args]);
          return b;
        };
      }
      b.then = (resolve: (r: unknown) => unknown) => {
        const has = (m: string) => calls.some(([c]) => c === m);
        if (has('delete')) {
          const id = calls.find(
            ([m, a]) => m === 'eq' && a[0] === 'id'
          )?.[1][1];
          return resolve({ data: [{ id }], error: null });
        }
        if (has('update')) return resolve({ data: null, error: null });
        if (has('lt')) return resolve({ data: opts.abandoned, error: null });
        return resolve({ data: opts.rest ?? [], error: null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  const ofKind = (m: string) => queries.filter((q) => q.some(([c]) => c === m));
  return { db, queries, ofKind };
}

const NOW = new Date('2026-10-28T12:00:00Z');
const row = {
  id: 'cfg-1',
  account_id: 'acct-1',
  phone_number_id: 'sess-1',
};

describe('sweepAbandonedOpenWASessions', () => {
  beforeEach(() => {
    vi.stubEnv('OPENWA_API_KEY', 'admin-key');
    for (const fn of Object.values(gw)) fn.mockReset();
    gw.logoutSession.mockResolvedValue(undefined);
    gw.deleteSession.mockResolvedValue(undefined);
    gw.findScopedKeyIds.mockResolvedValue(['key-1']);
    gw.revokeKey.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lists only never-connected OpenWA rows older than 30 minutes', async () => {
    const { db, ofKind } = fakeAdmin({ abandoned: [] });
    await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    const [list] = ofKind('lt');
    expect(list).toEqual(
      expect.arrayContaining([
        ['eq', ['provider', 'openwa']],
        ['is', ['connected_at', null]],
        [
          'lt',
          [
            'created_at',
            new Date(NOW.getTime() - OPENWA_ABANDONED_AFTER_MS).toISOString(),
          ],
        ],
      ])
    );
    expect(OPENWA_ABANDONED_AFTER_MS).toBe(30 * 60_000);
  });

  it('tears the session down with the admin key, then deletes the row', async () => {
    const { db, ofKind } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary).toEqual({ found: 1, removed: 1, failed: 0 });
    const target = { adminKey: 'admin-key', sessionId: 'sess-1' };
    expect(gw.logoutSession).toHaveBeenCalledWith(target);
    expect(gw.deleteSession).toHaveBeenCalledWith(target);
    expect(gw.findScopedKeyIds).toHaveBeenCalledWith(target);
    expect(gw.revokeKey).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      keyId: 'key-1',
    });
    const [del] = ofKind('delete');
    // Still never connected at delete time: a late link keeps its row.
    expect(del).toEqual(
      expect.arrayContaining([
        ['eq', ['id', 'cfg-1']],
        ['eq', ['account_id', 'acct-1']],
        ['is', ['connected_at', null]],
      ])
    );
  });

  it('keeps the row when the gateway cleanup did not finish', async () => {
    gw.deleteSession.mockRejectedValue(new OpenWAError('down', 503));
    const { db, ofKind } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary).toEqual({ found: 1, removed: 0, failed: 1 });
    expect(ofKind('delete')).toEqual([]);
  });

  it('keeps the row when a key could not be revoked', async () => {
    gw.revokeKey.mockRejectedValue(new OpenWAError('down', 503));
    const { db, ofKind } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary.failed).toBe(1);
    expect(ofKind('delete')).toEqual([]);
  });

  it('treats an already-gone session as cleaned up', async () => {
    gw.logoutSession.mockRejectedValue(new OpenWAError('not started', 400));
    gw.deleteSession.mockRejectedValue(new OpenWAError('gone', 404));
    const { db } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary.removed).toBe(1);
  });

  it('promotes the oldest remaining number when the abandoned one was primary', async () => {
    const { db, ofKind } = fakeAdmin({
      abandoned: [row],
      rest: [{ id: 'cfg-2', is_primary: false }],
    });
    await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    const [promote] = ofKind('update');
    expect(promote).toEqual(
      expect.arrayContaining([
        ['update', [{ is_primary: true }]],
        ['eq', ['id', 'cfg-2']],
      ])
    );
  });

  it('does nothing without the admin key', async () => {
    vi.stubEnv('OPENWA_API_KEY', '');
    const { db, queries } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary).toEqual({ found: 0, removed: 0, failed: 0 });
    expect(queries).toEqual([]);
    expect(gw.deleteSession).not.toHaveBeenCalled();
  });
});
