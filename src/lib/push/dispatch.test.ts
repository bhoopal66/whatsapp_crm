import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('web-push', () => ({ default: { sendNotification: h.send } }));

import { dispatchPush } from './dispatch';

interface Op {
  table: string;
  op: 'select' | 'update' | 'delete';
  payload?: unknown;
  filters: [string, unknown][];
}

function fakeDb(state: {
  rows: Record<string, unknown>[];
  subs: Record<string, unknown>[];
  prefs?: Record<string, unknown>[];
}) {
  const rpcs: [string, Record<string, unknown>][] = [];
  const ops: Op[] = [];
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push([name, args]);
      return Promise.resolve({
        data: name === 'push_claim' ? state.rows : null,
        error: null,
      });
    },
    from(table: string) {
      const op: Op = { table, op: 'select', filters: [] };
      ops.push(op);
      const result = () =>
        table === 'push_subscriptions' && op.op === 'select'
          ? { data: state.subs, error: null }
          : table === 'push_preferences' && op.op === 'select'
            ? { data: state.prefs ?? [], error: null }
            : { data: null, error: null };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: unknown) => ((op.op = 'update'), (op.payload = p), b),
        delete: () => ((op.op = 'delete'), b),
        eq: (c: string, v: unknown) => (op.filters.push([c, v]), b),
        is: (c: string, v: unknown) => (op.filters.push([c, v]), b),
        in: (c: string, v: unknown) => (op.filters.push([c, v]), b),
        then: (res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(res, rej),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, rpcs, ops };
}

const CLAIMED = '2026-10-15T10:00:00.123456+00:00';
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  user_id: 'u1',
  account_id: 'a1',
  kind: 'chat_message',
  title: 'Sam in #general',
  body: 'hello',
  url: '/chat/c1',
  tag: 'chat:c1',
  created_at: new Date().toISOString(),
  attempts: 1,
  claimed_at: CLAIMED,
  ...over,
});
const sub = (id: string, failure_count = 0) => ({
  id,
  user_id: 'u1',
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: 'p',
  auth: 'a',
  failure_count,
});
const gone = (statusCode: number) =>
  Object.assign(new Error('push service'), { statusCode });

beforeEach(() => {
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.VAPID_SUBJECT = 'https://crm.example';
  h.send.mockReset().mockResolvedValue({ statusCode: 201 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

const settled = (rpcs: [string, Record<string, unknown>][]) =>
  rpcs.filter(([n]) => n === 'push_settle').map(([, a]) => a);

describe('dispatchPush', () => {
  it('does nothing without VAPID keys', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const f = fakeDb({ rows: [row()], subs: [sub('s1')] });
    expect(await dispatchPush(f.db)).toMatchObject({ claimed: 0 });
    expect(f.rpcs).toEqual([]);
  });

  it('sends to every device with TTL, urgency and the payload, then settles ok', async () => {
    const f = fakeDb({ rows: [row()], subs: [sub('s1'), sub('s2')] });
    const s = await dispatchPush(f.db, { limit: 20 });
    expect(f.rpcs[0]).toEqual(['push_claim', { p_limit: 20 }]);
    expect(h.send).toHaveBeenCalledTimes(2);
    const [target, payload, opts] = h.send.mock.calls[0];
    expect(target).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/s1',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(JSON.parse(payload)).toMatchObject({
      title: 'Sam in #general',
      kind: 'chat_message',
      url: '/chat/c1',
    });
    expect(opts).toMatchObject({
      TTL: 86_400,
      urgency: 'high',
      timeout: 10_000,
      vapidDetails: { subject: 'https://crm.example' },
    });
    expect(settled(f.rpcs)).toEqual([
      { p_id: 1, p_ok: true, p_error: null, p_claimed_at: CLAIMED },
    ]);
    expect(
      f.ops.filter((o) => o.op === 'update' && o.table === 'push_subscriptions')
    ).toHaveLength(2);
    expect(s).toMatchObject({ claimed: 1, sent: 1 });
  });

  it('deletes a device the push service reports gone (410/404)', async () => {
    h.send.mockRejectedValueOnce(gone(410)).mockRejectedValueOnce(gone(404));
    const f = fakeDb({ rows: [row()], subs: [sub('s1'), sub('s2')] });
    const s = await dispatchPush(f.db);
    const deletes = f.ops.filter((o) => o.op === 'delete');
    expect(deletes.map((d) => d.filters)).toEqual([
      [['id', 's1']],
      [['id', 's2']],
    ]);
    expect(settled(f.rpcs)).toEqual([]);
    expect(s.skipped).toBe(1);
  });

  it('never sends to a stored endpoint that is not a push service, and removes it', async () => {
    const f = fakeDb({
      rows: [row()],
      subs: [{ ...sub('bad'), endpoint: 'https://10.0.0.5/x' }, sub('s1')],
    });
    const s = await dispatchPush(f.db);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].endpoint).toBe(
      'https://fcm.googleapis.com/fcm/send/s1'
    );
    expect(
      f.ops.filter((o) => o.op === 'delete').map((d) => d.filters)
    ).toEqual([[['id', 'bad']]]);
    expect(s.sent).toBe(1);
  });

  it('counts other failures against the device, drops it at 10, and settles failed for a retry', async () => {
    h.send.mockRejectedValue(gone(500));
    const f = fakeDb({ rows: [row()], subs: [sub('s1', 3), sub('s2', 9)] });
    const s = await dispatchPush(f.db);
    expect(
      f.ops.find((o) => o.op === 'update' && o.table === 'push_subscriptions')
        ?.payload
    ).toEqual({ failure_count: 4 });
    expect(
      f.ops.filter((o) => o.op === 'delete').map((d) => d.filters)
    ).toEqual([[['id', 's2']]]);
    expect(settled(f.rpcs)[0]).toMatchObject({
      p_id: 1,
      p_ok: false,
      p_claimed_at: CLAIMED,
    });
    expect(s.failed).toBe(1);
  });

  it('holds a chat message during quiet hours, refunding the attempt, but sends a reminder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T19:00:00Z')); // 23:00 Dubai
    const f = fakeDb({
      rows: [
        row({ id: 1, attempts: 1 }),
        row({ id: 2, kind: 'meeting_reminder' }),
      ],
      subs: [sub('s1')],
      prefs: [
        {
          user_id: 'u1',
          enabled: true,
          kinds: {},
          quiet_start: '22:00:00',
          quiet_end: '07:00:00',
          time_zone: 'Asia/Dubai',
        },
      ],
    });
    const s = await dispatchPush(f.db);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.send.mock.calls[0][1]).kind).toBe('meeting_reminder');
    const hold = f.ops.find(
      (o) => o.table === 'push_outbox' && o.op === 'update'
    );
    expect(hold?.payload).toEqual({
      claimed_at: '2026-10-16T02:58:00.000Z',
      attempts: 0,
    });
    expect(hold?.filters).toEqual([
      ['id', 1],
      ['claimed_at', CLAIMED],
      ['sent_at', null],
    ]);
    expect(settled(f.rpcs)).toEqual([
      { p_id: 2, p_ok: true, p_error: null, p_claimed_at: CLAIMED },
    ]);
    expect(s).toMatchObject({ held: 1, sent: 1 });
  });

  it('skips a row whose kind was switched off, or whose person has no device', async () => {
    const f = fakeDb({
      rows: [
        row({ id: 1 }),
        row({ id: 2, user_id: 'u2', kind: 'task_assigned' }),
      ],
      subs: [sub('s1')],
      prefs: [
        {
          user_id: 'u1',
          enabled: true,
          kinds: { chat_message: false },
          quiet_start: null,
          quiet_end: null,
          time_zone: null,
        },
      ],
    });
    const s = await dispatchPush(f.db);
    expect(h.send).not.toHaveBeenCalled();
    const skips = f.ops.filter(
      (o) => o.table === 'push_outbox' && o.op === 'update'
    );
    expect(
      skips.map((o) => (o.payload as { last_error: string }).last_error)
    ).toEqual(['skipped: push switched off', 'skipped: no device']);
    for (const o of skips) {
      expect(o.filters).toContainEqual(['claimed_at', CLAIMED]);
    }
    expect(s.skipped).toBe(2);
  });

  it('releases the rows it never reached once the pass is out of time', async () => {
    let t = 0;
    h.send.mockImplementation(async () => {
      t += 40_000; // each send eats 40 s of a 60 s budget
      return { statusCode: 201 };
    });
    const f = fakeDb({
      rows: [
        row({ id: 1 }),
        row({ id: 2, claimed_at: 'c2' }),
        row({ id: 3, claimed_at: 'c3' }),
      ],
      subs: [sub('s1')],
    });
    const s = await dispatchPush(f.db, { budgetMs: 60_000, clock: () => t });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(f.rpcs.filter(([n]) => n === 'push_release')).toEqual([
      ['push_release', { p_id: 3, p_claimed_at: 'c3' }],
    ]);
    expect(settled(f.rpcs).map((a) => a.p_id)).toEqual([1, 2]);
    expect(s).toMatchObject({ claimed: 3, sent: 2, released: 1 });
  });

  it('never throws', async () => {
    const f = fakeDb({ rows: [row()], subs: [sub('s1')] });
    (f.db as unknown as { rpc: unknown }).rpc = () =>
      Promise.reject(new Error('down'));
    await expect(dispatchPush(f.db)).resolves.toMatchObject({ claimed: 0 });
  });
});
