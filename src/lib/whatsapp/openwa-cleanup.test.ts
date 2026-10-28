import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const gw = vi.hoisted(() => ({
  logoutSession: vi.fn(),
  deleteSession: vi.fn(),
  findScopedKeyIds: vi.fn(),
  revokeKey: vi.fn(),
  getSession: vi.fn(),
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
    gw.getSession.mockResolvedValue({ status: 'qr_ready', phone: null });
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
    expect(summary).toEqual({
      found: 1,
      removed: 1,
      failed: 0,
      linked: 0,
      kept: 0,
    });
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
    expect(summary).toMatchObject({ found: 1, removed: 0, failed: 1 });
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

  it('stamps a phone that linked after all instead of logging it out', async () => {
    gw.getSession.mockResolvedValue({ status: 'ready', phone: '971500000001' });
    const { db, ofKind } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary).toMatchObject({ found: 1, linked: 1, removed: 0 });
    expect(gw.getSession).toHaveBeenCalledWith({
      apiKey: 'admin-key',
      sessionId: 'sess-1',
    });
    expect(gw.logoutSession).not.toHaveBeenCalled();
    expect(gw.deleteSession).not.toHaveBeenCalled();
    expect(ofKind('delete')).toEqual([]);
    const [stamp] = ofKind('update');
    expect(stamp).toEqual(
      expect.arrayContaining([
        [
          'update',
          [
            {
              status: 'connected',
              connected_at: NOW.toISOString(),
              waba_id: '971500000001',
            },
          ],
        ],
        ['eq', ['id', 'cfg-1']],
        ['is', ['connected_at', null]],
      ])
    );
  });

  it('leaves a session mid-link, or one the gateway cannot report on, for the next sweep', async () => {
    for (const answer of [
      () => gw.getSession.mockResolvedValue({ status: 'authenticating' }),
      () => gw.getSession.mockRejectedValue(new OpenWAError('down', 503)),
    ]) {
      answer();
      gw.logoutSession.mockClear();
      gw.deleteSession.mockClear();
      const { db, ofKind } = fakeAdmin({ abandoned: [row] });
      const summary = await sweepAbandonedOpenWASessions(db, {
        now: () => NOW,
      });
      expect(summary).toMatchObject({ found: 1, kept: 1, removed: 0 });
      expect(gw.logoutSession).not.toHaveBeenCalled();
      expect(gw.deleteSession).not.toHaveBeenCalled();
      expect(ofKind('delete')).toEqual([]);
    }
  });

  it('never tears down a session whose state does not rule a link out', async () => {
    // A gateway restoring a saved login after a restart says
    // `initializing`; a linked phone reconnecting says `disconnected`.
    const young = { ...row, created_at: '2026-10-28T11:00:00Z' };
    for (const status of [
      'created',
      'initializing',
      'disconnected',
      'something_new',
    ]) {
      gw.getSession.mockResolvedValue({ status, phone: null });
      gw.logoutSession.mockClear();
      gw.deleteSession.mockClear();
      const { db, ofKind } = fakeAdmin({ abandoned: [young] });
      const summary = await sweepAbandonedOpenWASessions(db, {
        now: () => NOW,
      });
      expect(summary).toMatchObject({ found: 1, kept: 1, removed: 0 });
      expect(gw.logoutSession).not.toHaveBeenCalled();
      expect(gw.deleteSession).not.toHaveBeenCalled();
      expect(ofKind('delete')).toEqual([]);
    }
  });

  it('gives up on a session still unsure a day after connecting', async () => {
    gw.getSession.mockResolvedValue({ status: 'initializing', phone: null });
    const old = { ...row, created_at: '2026-10-27T11:00:00Z' };
    const { db, ofKind } = fakeAdmin({ abandoned: [old] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary).toMatchObject({ found: 1, removed: 1 });
    expect(gw.deleteSession).toHaveBeenCalled();
    expect(ofKind('delete')).toHaveLength(1);
  });

  it('tears down a definite not-linked session after 30 minutes', async () => {
    for (const status of ['qr_ready', 'failed', 'action_required']) {
      gw.getSession.mockResolvedValue({ status, phone: null });
      gw.deleteSession.mockClear();
      const young = { ...row, created_at: '2026-10-28T11:00:00Z' };
      const { db } = fakeAdmin({ abandoned: [young] });
      const summary = await sweepAbandonedOpenWASessions(db, {
        now: () => NOW,
      });
      expect(summary).toMatchObject({ found: 1, removed: 1 });
      expect(gw.deleteSession).toHaveBeenCalled();
    }
  });

  it('tears down a session the gateway no longer has (its key may remain)', async () => {
    gw.getSession.mockRejectedValue(
      new OpenWAError('gone', 404, { route: 'session' })
    );
    const { db } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary.removed).toBe(1);
    expect(gw.revokeKey).toHaveBeenCalled();
  });

  it('takes least recently touched rows first, and requeues one it keeps', async () => {
    gw.deleteSession.mockRejectedValue(new OpenWAError('down', 503));
    const { db, ofKind } = fakeAdmin({ abandoned: [row] });
    await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    const [list] = ofKind('lt');
    const orders = list.filter(([m]) => m === 'order').map(([, a]) => a[0]);
    expect(orders).toEqual(['updated_at', 'created_at']);
    const [requeue] = ofKind('update');
    expect(requeue).toEqual(
      expect.arrayContaining([
        ['eq', ['id', 'cfg-1']],
        ['is', ['connected_at', null]],
      ])
    );
    expect(requeue[0][0]).toBe('update');
    expect(Object.keys(requeue[0][1][0] as object)).toEqual(['updated_at']);
  });

  it('does nothing without the admin key', async () => {
    vi.stubEnv('OPENWA_API_KEY', '');
    const { db, queries } = fakeAdmin({ abandoned: [row] });
    const summary = await sweepAbandonedOpenWASessions(db, { now: () => NOW });
    expect(summary).toEqual({
      found: 0,
      removed: 0,
      failed: 0,
      linked: 0,
      kept: 0,
    });
    expect(queries).toEqual([]);
    expect(gw.deleteSession).not.toHaveBeenCalled();
  });
});
