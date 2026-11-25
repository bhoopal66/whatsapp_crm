import { beforeEach, describe, expect, it, vi } from 'vitest';

const pbx = vi.hoisted(() => ({
  open: vi.fn(),
}));
vi.mock('../connection', async (original) => ({
  ...(await original<typeof import('../connection')>()),
  pbxApiFor: pbx.open,
}));

import { PbxConnectionError } from '../connection';
import { runPbxCron } from '../housekeeping';
import { ingestPbxEvent } from '../process';
import { reconcileLostCalls } from '../reconcile-calls';
import { onceEvery } from '../stale-calls';
import { YeastarError } from '../yeastar/errors';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

const A = 'acc';
const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const LAST_EVENT = '2026-10-12T08:00:00.000Z';
const MIN = 60_000;

/** A leg that ended `endedAgo` minutes before NOW, after a minute. */
const cdr = (
  callId: string,
  disposition: string,
  endedAgo: number,
  extra: Row = {}
) => ({
  uid: `uid-${callId}`,
  call_id: callId,
  call_type: 'Inbound',
  call_from_number: '0501234567',
  call_to_number: '1001',
  timestamp: Math.floor((NOW - (endedAgo + 1) * MIN) / 1000),
  duration: 60,
  talk_duration: disposition === 'ANSWERED' ? 40 : 0,
  disposition,
  did_number: '043334444',
  ...extra,
});

let fake: FakeDb;
/** The PBX's answer per connection; an Error is thrown when it is opened. */
let pbxSays: Record<string, Row[] | Error>;
let total: number | undefined;
/** The calls up on the PBX now; an Error is thrown. */
let upNow: string[] | Error;
const searches: Row[] = [];
const run = (now: () => number = () => NOW) =>
  reconcileLostCalls({ db: fake.db, now, open: pbx.open });
const count = (table: string) => (fake.tables[table] ?? []).length;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  searches.length = 0;
  total = undefined;
  upNow = [];
  pbxSays = {};
  pbx.open.mockReset();
  pbx.open.mockImplementation(async (_db: unknown, id: string) => {
    const says = pbxSays[id] ?? [];
    if (says instanceof Error) throw says;
    return {
      api: {
        queryCalls: async (q: Row) => {
          if (upNow instanceof Error) throw upNow;
          return q.type === 'inbound'
            ? upNow.map((callId) => ({ callId, members: [] }))
            : [];
        },
        searchCdr: async (s: Row) => {
          searches.push(s);
          return { total: total ?? says.length, records: says };
        },
      },
    };
  });
  const extension = (n: string, user: string) => ({
    connection_id: 'c1',
    extension: n,
    account_id: A,
    user_id: user,
    presence_monitor: true,
  });
  const profile = (user_id: string) => ({
    user_id,
    account_id: A,
    account_role: 'agent',
    deactivated_at: null,
  });
  fake = createFakeDb(
    {
      pbx_connections: [
        {
          id: 'c1',
          account_id: A,
          status: 'connected',
          last_event_at: LAST_EVENT,
        },
      ],
      pbx_extensions: [extension('1001', 'u1'), extension('1002', 'u2')],
      profiles: [profile('u1'), profile('u2')],
    },
    {},
    { tasks: { status: 'open' } }
  );
});

describe('reconcileLostCalls', () => {
  it('records an answered call nobody told us about, and rings nobody', async () => {
    pbxSays.c1 = [cdr('a', 'ANSWERED', 20)];
    expect(await run()).toMatchObject({ recovered: 1, rung: 0, failed: 0 });
    expect(fake.tables.calls).toHaveLength(1);
    expect(fake.tables.calls[0]).toMatchObject({
      pbx_call_id: 'a',
      status: 'answered',
      user_id: 'u1',
    });
    expect(count('tasks')).toBe(0);
    expect(count('notifications')).toBe(0);
    expect(count('call_live')).toBe(0);
    expect(searches).toEqual([
      {
        startTime: new Date(NOW - 60 * MIN),
        endTime: new Date(NOW),
        page: 1,
        pageSize: 1000,
      },
    ]);
  });

  it('leaves a call the CRM has, and one that appears before its first leg', async () => {
    const row = {
      id: 'k',
      connection_id: 'c1',
      pbx_call_id: 'a',
      status: 'no_answer',
    };
    fake.tables.calls = [{ ...row }];
    pbxSays.c1 = [cdr('a', 'NO ANSWER', 20)];
    await run();
    expect(fake.tables.calls).toEqual([row]);
    expect(count('pbx_events_raw')).toBe(0);

    // Its own event arrives between the plan's read and the call's turn.
    fake.tables.calls = [];
    const from = fake.db.from.bind(fake.db);
    let reads = 0;
    const db = {
      from: (table: string) => {
        if (table === 'calls' && ++reads === 3)
          fake.tables.calls.push({ ...row });
        return from(table);
      },
    } as unknown as FakeDb['db'];
    await reconcileLostCalls({ db, now: () => NOW, open: pbx.open });
    expect(fake.tables.calls).toEqual([row]);
    expect(count('pbx_events_raw')).toBe(0);
  });

  describe('a live row whose end event was lost', () => {
    const liveRow = (status: string, startedAgo = 22) => {
      fake.tables.calls = [
        {
          id: 'k',
          account_id: A,
          connection_id: 'c1',
          pbx_call_id: 'a',
          direction: 'inbound',
          status,
          remote_number: '971501234567',
          started_at: new Date(NOW - startedAgo * MIN).toISOString(),
          meta: { rang_user_ids: ['u1'] },
        },
      ];
      fake.tables.call_live = [
        { connection_id: 'c1', pbx_call_id: 'a', ringing_user_ids: ['u1'] },
      ];
    };
    const untouched = (status: string) => {
      expect(fake.tables.calls).toMatchObject([{ id: 'k', status }]);
      expect(count('pbx_events_raw')).toBe(0);
      expect(count('call_live')).toBe(1);
      expect(count('tasks')).toBe(0);
    };

    it('missed: its task and bell, once, also when the end comes late', async () => {
      liveRow('ringing');
      pbxSays.c1 = [cdr('a', 'NO ANSWER', 20)];
      expect(await run()).toMatchObject({ recovered: 1, rung: 1 });
      expect(fake.tables.calls).toMatchObject([
        { id: 'k', status: 'no_answer' },
      ]);
      expect(count('call_live')).toBe(0);
      expect(fake.tables.tasks).toMatchObject([
        { source_ref: 'call:k', assigned_to: 'u1' },
      ]);
      await run(() => NOW + 15 * MIN);
      await ingestPbxEvent({
        db: fake.db,
        connectionId: 'c1',
        receivedAt: new Date(NOW + 16 * MIN),
        payload: {
          type: 30012,
          sn: 'SN1',
          msg: {
            call_id: 'a',
            uid: 'uid-a',
            type: 'Inbound',
            call_from: '0501234567',
            call_to: '6300',
            time_start: '2026-10-12 13:39:00',
            call_duration: 61,
            talk_duration: 0,
            status: 'NO ANSWER',
          },
        },
      });
      expect(count('tasks')).toBe(1);
      expect(count('notifications')).toBe(1);
    });

    it('answered: recorded, its screen pop cleared, nobody rung', async () => {
      liveRow('in_progress');
      pbxSays.c1 = [cdr('a', 'ANSWERED', 20)];
      expect(await run()).toMatchObject({ recovered: 1, rung: 0 });
      expect(fake.tables.calls).toMatchObject([
        { id: 'k', status: 'answered' },
      ]);
      expect(count('call_live')).toBe(0);
      expect(count('tasks')).toBe(0);
    });

    it('is left while the PBX still has the call up, or cannot say', async () => {
      // A finished leg's record, the customer still on the line.
      liveRow('in_progress');
      pbxSays.c1 = [cdr('a', 'ANSWERED', 15)];
      upNow = ['a'];
      await run();
      untouched('in_progress');
      liveRow('ringing');
      pbxSays.c1 = [cdr('a', 'NO ANSWER', 15)];
      await run();
      untouched('ringing');
      upNow = new Error('no permission');
      expect((await run()).errors).toEqual({});
      untouched('ringing');
    });

    it('is left when answered and its answered leg is not in the CDR', async () => {
      liveRow('in_progress');
      pbxSays.c1 = [cdr('a', 'NO ANSWER', 20)];
      await run();
      untouched('in_progress');
    });

    it('is left within the grace', async () => {
      liveRow('ringing', 6);
      pbxSays.c1 = [cdr('a', 'NO ANSWER', 5)];
      await run();
      untouched('ringing');
    });
  });

  it('a missed call before an answered one of the same run rings nobody', async () => {
    pbxSays.c1 = [cdr('a', 'NO ANSWER', 25), cdr('b', 'ANSWERED', 20)];
    expect(await run()).toMatchObject({ recovered: 2 });
    expect(count('tasks')).toBe(0);
    expect(count('notifications')).toBe(0);
  });

  it('a ring-group call one colleague answered opens nothing', async () => {
    pbxSays.c1 = [
      cdr('a', 'ANSWERED', 20, { call_to_number: '1002' }),
      cdr('a', 'NO ANSWER', 20),
    ];
    await run();
    expect(fake.tables.calls).toHaveLength(1);
    expect(fake.tables.calls[0]).toMatchObject({
      status: 'answered',
      user_id: 'u2',
    });
    expect(count('tasks')).toBe(0);
    expect(count('notifications')).toBe(0);
  });

  it('stores an answered leg first, so a run cut off half-way never looks missed', async () => {
    pbxSays.c1 = [
      cdr('a', 'NO ANSWER', 20),
      cdr('a', 'ANSWERED', 20, { call_to_number: '1002' }),
    ];
    await run();
    const stored = fake.tables.pbx_events_raw.map(
      (r) => (r.payload as { msg: Row }).msg.status
    );
    expect(stored).toEqual(['ANSWERED', 'NO ANSWER']);
  });

  it('a missed call opens its task and bell once, however often the step runs', async () => {
    pbxSays.c1 = [
      cdr('a', 'NO ANSWER', 20),
      cdr('a', 'NO ANSWER', 20, { call_to_number: '1002' }),
    ];
    expect(await run()).toMatchObject({ recovered: 1, rung: 1 });
    expect(fake.tables.calls).toHaveLength(1);
    expect(fake.tables.calls[0]).toMatchObject({ status: 'no_answer' });
    expect((fake.tables.calls[0].meta as Row).cdr_legs).toHaveLength(2);
    expect(count('tasks')).toBe(1);
    expect(count('notifications')).toBe(1);
    await run(() => NOW + 15 * MIN);
    expect(count('tasks')).toBe(1);
    expect(count('notifications')).toBe(1);

    // Nor does its own event, delivered late after all.
    await ingestPbxEvent({
      db: fake.db,
      connectionId: 'c1',
      receivedAt: new Date(NOW + 16 * MIN),
      payload: {
        type: 30012,
        sn: 'SN1',
        msg: {
          call_id: 'a',
          uid: 'uid-a',
          type: 'Inbound',
          call_from: '0501234567',
          call_to: '6300',
          time_start: '2026-10-12 13:39:00',
          call_duration: 61,
          talk_duration: 0,
          status: 'NO ANSWER',
          did_number: '043334444',
        },
      },
    });
    expect(count('tasks')).toBe(1);
    expect(count('notifications')).toBe(1);
  });

  it('one leg the PBX lists under two record ids still rings once', async () => {
    pbxSays.c1 = [
      cdr('a', 'NO ANSWER', 20, { id: 1 }),
      cdr('a', 'NO ANSWER', 20, { id: 2 }),
    ];
    await run();
    expect(count('tasks')).toBe(1);
  });

  it('a missed call that ended over an hour ago opens nothing', async () => {
    pbxSays.c1 = [cdr('a', 'NO ANSWER', 70)];
    await run();
    expect(count('tasks')).toBe(0);
    expect(count('notifications')).toBe(0);
  });

  it('rings nobody for a call whose other legs may be out of sight', async () => {
    // At the window's edge, then on a page the PBX cut short.
    pbxSays.c1 = [cdr('a', 'NO ANSWER', 56)];
    await run();
    total = 1500;
    pbxSays.c1 = [cdr('b', 'NO ANSWER', 20)];
    await run();
    expect(fake.tables.calls.map((c) => c.pbx_call_id)).toEqual(['a', 'b']);
    expect(count('tasks')).toBe(0);
  });

  it('leaves a call that ended 5 minutes ago for the next run', async () => {
    pbxSays.c1 = [
      cdr('a', 'NO ANSWER', 20),
      cdr('a', 'NO ANSWER', 5, { call_to_number: '1002' }),
    ];
    await run();
    expect(count('calls')).toBe(0);
    await run(() => NOW + 15 * MIN);
    expect(count('calls')).toBe(1);
    expect(count('tasks')).toBe(1);
  });

  it('leaves the link clock alone, so the silence alert still rings', async () => {
    pbxSays.c1 = [cdr('a', 'ANSWERED', 25), cdr('b', 'NO ANSWER', 20)];
    expect(await run()).toMatchObject({ recovered: 2, rung: 1 });
    expect(fake.tables.pbx_connections[0]).toMatchObject({
      last_event_at: LAST_EVENT,
    });
  });

  it('a leg that fails before anything is stored leaves the call for the next run', async () => {
    pbxSays.c1 = [
      cdr('a', 'NO ANSWER', 20),
      cdr('a', 'NO ANSWER', 20, { call_to_number: '1002' }),
    ];
    fake.fail('calls', 'upsert', { message: 'down' });
    expect(await run()).toMatchObject({ recovered: 0, failed: 1 });
    expect(count('tasks')).toBe(0);
    expect(await run()).toMatchObject({ recovered: 1, rung: 1 });
    expect(count('tasks')).toBe(1);
  });

  it('goes on past a connection whose PBX fails, and never asks one never set up', async () => {
    const conn = (id: string, last_event_at: string | null) => ({
      id,
      account_id: A,
      status: 'connected',
      last_event_at,
    });
    fake.tables.pbx_connections = [
      conn('c8', null),
      conn('c9', LAST_EVENT),
      conn('c0', LAST_EVENT),
      conn('c1', LAST_EVENT),
    ];
    pbxSays.c9 = new YeastarError({
      endpoint: 'cdr/search',
      errcode: null,
      errmsg: 'TIMEOUT',
    });
    pbxSays.c0 = new PbxConnectionError('auth_backoff', 'backing off');
    pbxSays.c1 = [cdr('a', 'ANSWERED', 20)];
    const out = await run();
    expect(Object.keys(out.errors)).toEqual(['c9']);
    expect(out.recovered).toBe(1);
    expect(pbx.open.mock.calls.map((c) => c[1])).toEqual(['c9', 'c0', 'c1']);
  });

  it('starts nothing past the deadline', async () => {
    pbxSays.c1 = [cdr('a', 'ANSWERED', 20)];
    await reconcileLostCalls({
      db: fake.db,
      now: () => NOW,
      deadline: NOW,
      open: pbx.open,
    });
    expect(pbx.open).not.toHaveBeenCalled();
  });

  it('runs from the cron at most once per 15 minutes', async () => {
    const reconcileDue = onceEvery(15 * MIN);
    const cron = (at: number) =>
      runPbxCron({
        db: fake.db,
        now: () => at,
        staleCallsDue: () => false,
        reconcileDue,
      });
    pbxSays.c1 = [cdr('a', 'ANSWERED', 20)];
    expect((await cron(NOW)).reconcile).toMatchObject({ recovered: 1 });
    expect((await cron(NOW + 14 * MIN)).reconcile).toBeUndefined();
    pbxSays.c1 = new Error('PBX gone');
    const failed = await cron(NOW + 15 * MIN);
    expect(failed.errors.reconcile).toContain('PBX gone');
    // The steps after it still ran: purge has no rpc here, so it errs.
    expect(failed.errors.purge).toBeTruthy();
    expect(searches).toHaveLength(1);
  });
});
