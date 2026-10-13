import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dialDueCallbacks,
  inCallbackHours,
  releaseStaleCallbacks,
  STALE_DIALING_MS,
} from '../callbacks';
import type { PbxHandle } from '../connection';
import { PbxConnectionError } from '../connection';
import { retryFailedPbxEvents } from '../housekeeping';
import { ingestPbxEvent } from '../process';
import {
  fetchPendingRecordings,
  pastRetention,
  retentionAgeFrom,
} from '../recordings';
import { YeastarError } from '../yeastar/errors';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

const A = 'acc';
// 14:00 in Dubai (UTC+4); 21:00 Dubai is 17:00Z.
const DAY = Date.parse('2026-10-12T10:00:00.000Z');
const NIGHT = Date.parse('2026-10-12T17:00:00.000Z');
// A `dialing` request last touched a minute past the stale limit at DAY.
const STALE_AT = new Date(DAY - STALE_DIALING_MS - 60_000).toISOString();
let fake: FakeDb;

const busy = () =>
  new YeastarError({
    endpoint: 'recording/download',
    errcode: 70651,
    errmsg: 'BUSY',
  });
const audio = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': 'audio/mpeg' },
  });
const handle = (api: Record<string, unknown>) => async () =>
  ({ api }) as unknown as PbxHandle;
const call = (id: string, state = 'pending', meta: Row = {}) => ({
  id,
  account_id: A,
  connection_id: 'c1',
  recording_state: state,
  recording_file: `${id}.mp3`,
  meta,
  updated_at: id,
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fetchPendingRecordings', () => {
  it('downloads one at a time into private storage and never stores the URL', async () => {
    fake = createFakeDb({
      calls: [call('k1'), call('k2'), call('k3', 'held'), call('k4', 'erased')],
      pbx_settings: [{ account_id: A, announcement_required: false }],
    });
    const asked: unknown[] = [];
    let inFlight = 0;
    let most = 0;
    const out = await fetchPendingRecordings({
      db: fake.db,
      apiFor: handle({
        recordingDownloadUrl: async (ref: unknown) => {
          asked.push(ref);
          return 'https://pbx/api/dl?token=SECRET';
        },
      }),
      fetch: async () => {
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return audio();
      },
    });
    expect(out).toMatchObject({ fetched: 2, failed: 0, busy: false });
    expect(most).toBe(1);
    expect(asked).toEqual([{ file: 'k1.mp3' }, { file: 'k2.mp3' }]);
    expect(Object.keys(fake.objects)).toEqual([
      `call-recordings/account-${A}/calls/k1.mp3`,
      `call-recordings/account-${A}/calls/k2.mp3`,
    ]);
    expect(fake.tables.call_recordings[0]).toMatchObject({
      call_id: 'k1',
      bytes: 3,
      format: 'mp3',
      // Fetched while the notice was switched off: not known to be
      // announced, so held if the requirement is switched back on (C-1).
      announcement_played: false,
    });
    const k1 = fake.tables.calls.find((c) => c.id === 'k1')!;
    expect(k1).toMatchObject({
      recording_state: 'fetched',
      announcement_played: false,
    });
    expect(k1.meta).toEqual({ announcement_basis: 'not_required' });
    expect(JSON.stringify(fake.tables)).not.toContain('SECRET');
    expect(fake.tables.calls.find((c) => c.id === 'k3')!.recording_state).toBe(
      'held'
    );
  });

  it('marks a recording announced only while the workspace requires the notice', async () => {
    // No pbx_settings row: the requirement is on (the default).
    fake = createFakeDb({ calls: [call('k1')] });
    const out = await fetchPendingRecordings({
      db: fake.db,
      apiFor: handle({ recordingDownloadUrl: async () => 'https://pbx/dl' }),
      fetch: async () => audio(),
    });
    expect(out.fetched).toBe(1);
    expect(fake.tables.call_recordings[0]).toMatchObject({
      call_id: 'k1',
      announcement_played: true,
    });
    const k1 = fake.tables.calls.find((c) => c.id === 'k1')!;
    expect(k1).toMatchObject({
      recording_state: 'fetched',
      announcement_played: true,
    });
    expect(k1.meta).toEqual({ announcement_basis: 'pbx_prompt' });
  });

  it('stops the run on 70651 without spending an attempt', async () => {
    fake = createFakeDb({ calls: [call('k1'), call('k2')] });
    const url = vi.fn().mockRejectedValue(busy());
    const out = await fetchPendingRecordings({
      db: fake.db,
      apiFor: handle({ recordingDownloadUrl: url }),
      fetch: async () => audio(),
    });
    expect(out.busy).toBe(true);
    expect(url).toHaveBeenCalledTimes(1);
    expect(fake.tables.calls.map((c) => c.meta)).toEqual([{}, {}]);
  });

  it('counts other failures and gives up on the fifth', async () => {
    fake = createFakeDb({
      calls: [
        call('k1', 'pending', { recording_attempts: 3 }),
        call('k2', 'pending', { recording_attempts: 4 }),
      ],
    });
    const out = await fetchPendingRecordings({
      db: fake.db,
      apiFor: handle({ recordingDownloadUrl: async () => 'https://pbx/x' }),
      fetch: async () => new Response('nope', { status: 500 }),
    });
    expect(out).toMatchObject({ failed: 2, gaveUp: 1 });
    const [k1, k2] = fake.tables.calls;
    expect(k1).toMatchObject({
      recording_state: 'pending',
      meta: { recording_attempts: 4 },
    });
    expect(k2).toMatchObject({
      recording_state: 'failed',
      meta: { recording_attempts: 5 },
    });
  });

  it("marks a paused workspace's calls not stored and fetches the others", async () => {
    fake = createFakeDb({
      calls: [call('k1'), { ...call('k2'), account_id: 'acc-2' }],
      pbx_settings: [
        { account_id: A, store_recordings: false },
        { account_id: 'acc-2', store_recordings: true },
      ],
    });
    const asked: unknown[] = [];
    const out = await fetchPendingRecordings({
      db: fake.db,
      apiFor: handle({
        recordingDownloadUrl: async (ref: unknown) => {
          asked.push(ref);
          return 'https://pbx/dl';
        },
      }),
      fetch: async () => audio(),
    });
    expect(out).toMatchObject({ notStored: 1, fetched: 1, failed: 0 });
    expect(asked).toEqual([{ file: 'k2.mp3' }]);
    expect(Object.keys(fake.objects)).toEqual([
      'call-recordings/account-acc-2/calls/k2.mp3',
    ]);
    expect(fake.tables.calls.find((c) => c.id === 'k1')).toMatchObject({
      recording_state: 'not_stored',
      recording_file: 'k1.mp3',
      meta: {},
    });
    expect(fake.tables.calls.find((c) => c.id === 'k2')!.recording_state).toBe(
      'fetched'
    );
  });

  it('never contacts the PBX for a paused workspace', async () => {
    fake = createFakeDb({
      calls: [call('k1')],
      pbx_settings: [{ account_id: A, store_recordings: false }],
    });
    const apiFor = vi.fn(handle({}));
    const fetchFn = vi.fn(async () => audio());
    const out = await fetchPendingRecordings({
      db: fake.db,
      apiFor,
      fetch: fetchFn,
    });
    expect(out).toMatchObject({ notStored: 1, fetched: 0, failed: 0 });
    expect(apiFor).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(fake.tables.call_recordings ?? []).toHaveLength(0);
  });

  it('never downloads audio already past the retention period', async () => {
    const ago = (days: number) =>
      new Date(DAY - days * 86_400_000).toISOString();
    fake = createFakeDb({
      calls: [
        // 40 days old by both clocks: past a 30-day period.
        { ...call('k1'), started_at: ago(40), created_at: ago(40) },
        // The PBX says 40 days, the CRM heard of it today: kept.
        { ...call('k2'), started_at: ago(40), created_at: ago(0) },
        // Another workspace, no period.
        {
          ...call('k3'),
          account_id: 'acc-2',
          started_at: ago(40),
          created_at: ago(40),
        },
      ],
      pbx_settings: [
        {
          account_id: A,
          retention_days: 30,
          retention_confirmed_at: '2026-10-01T00:00:00Z',
        },
        { account_id: 'acc-2', retention_days: null },
      ],
    });
    const asked: unknown[] = [];
    const out = await fetchPendingRecordings({
      db: fake.db,
      now: () => DAY,
      apiFor: handle({
        recordingDownloadUrl: async (ref: unknown) => {
          asked.push(ref);
          return 'https://pbx/dl';
        },
      }),
      fetch: async () => audio(),
    });
    expect(out).toMatchObject({
      pastRetention: 1,
      notStored: 0,
      fetched: 2,
      failed: 0,
    });
    expect(asked).toEqual([{ file: 'k2.mp3' }, { file: 'k3.mp3' }]);
    expect(fake.tables.calls.find((c) => c.id === 'k1')).toMatchObject({
      recording_state: 'not_stored',
      meta: {},
    });
    expect(
      (fake.tables.call_recordings ?? []).map((r) => r.call_id).sort()
    ).toEqual(['k2', 'k3']);
  });

  it('downloads under a retention period nobody confirmed', async () => {
    const ago = (days: number) =>
      new Date(DAY - days * 86_400_000).toISOString();
    fake = createFakeDb({
      calls: [{ ...call('k1'), started_at: ago(40), created_at: ago(40) }],
      pbx_settings: [
        { account_id: A, retention_days: 30, retention_confirmed_at: null },
      ],
    });
    const out = await fetchPendingRecordings({
      db: fake.db,
      now: () => DAY,
      apiFor: handle({ recordingDownloadUrl: async () => 'https://pbx/dl' }),
      fetch: async () => audio(),
    });
    expect(out).toMatchObject({ pastRetention: 0, fetched: 1 });
    expect(fake.tables.call_recordings.map((r) => r.call_id)).toEqual(['k1']);
  });

  it('ages a call from the later of the PBX start and the CRM record', () => {
    const t = (iso: string) => Date.parse(iso);
    expect(
      retentionAgeFrom('2026-01-02T00:00:00Z', '2026-10-12T00:00:00Z')
    ).toBe(t('2026-10-12T00:00:00Z'));
    expect(
      retentionAgeFrom('2026-10-12T00:00:00Z', '2026-10-11T00:00:00Z')
    ).toBe(t('2026-10-12T00:00:00Z'));
    expect(retentionAgeFrom(undefined, 'x')).toBeNull();
    const old = {
      started_at: '2026-09-01T00:00:00Z',
      created_at: '2026-09-01T00:00:00Z',
    };
    const now = t('2026-10-12T00:00:00Z');
    expect(pastRetention(old, 30, now)).toBe(true);
    // Exactly 41 days old: not older than 41 days (SQL's strict <).
    expect(pastRetention(old, 40, now)).toBe(true);
    expect(pastRetention(old, 41, now)).toBe(false);
    expect(pastRetention(old, null, now)).toBe(false);
    expect(pastRetention({}, 1, now)).toBe(false);
  });

  it('skips a connection in auth backoff', async () => {
    fake = createFakeDb({ calls: [call('k1')] });
    const out = await fetchPendingRecordings({
      db: fake.db,
      apiFor: async () => {
        throw new PbxConnectionError('auth_backoff', 'wait');
      },
    });
    expect(out).toMatchObject({ skipped: 1, failed: 0 });
    expect(fake.tables.calls[0].meta).toEqual({});
  });
});

describe('dialDueCallbacks', () => {
  const dial = vi.fn();
  const setup = (req: Row = {}, contact: Row = {}, presence: Row = {}) => {
    fake = createFakeDb({
      callback_requests: [
        {
          id: 'r1',
          account_id: A,
          contact_id: 'ct1',
          status: 'pending',
          not_before: null,
          assigned_to: null,
          attempts: 0,
          created_at: '1',
          ...req,
        },
      ],
      contacts: [
        {
          id: 'ct1',
          account_id: A,
          phone: '971501234567',
          do_not_contact_at: null,
          user_id: 'u1',
          ...contact,
        },
      ],
      pbx_extensions: [
        {
          connection_id: 'c1',
          extension: '1001',
          account_id: A,
          user_id: 'u1',
          registration_state: 'registered',
        },
      ],
      pbx_presence: [
        {
          connection_id: 'c1',
          extension: '1001',
          presence: 'available',
          call_state: 'idle',
          ...presence,
        },
      ],
    });
  };
  const run = (now = DAY) =>
    dialDueCallbacks({ db: fake.db, now: () => now, apiFor: handle({ dial }) });
  beforeEach(() => {
    dial.mockReset().mockResolvedValue({ callId: 'pbx-9' });
  });

  it('dials from the owner extension within Dubai hours', async () => {
    setup();
    expect(await run()).toMatchObject({ dialled: 1 });
    expect(dial).toHaveBeenCalledWith({
      caller: '1001',
      callee: '971501234567',
    });
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'dialing',
      attempts: 1,
      pbx_call_id: 'pbx-9',
    });
  });

  it('never dials at 21:00 Dubai', async () => {
    expect(inCallbackHours(NIGHT)).toBe(false);
    setup();
    expect(await run(NIGHT)).toMatchObject({ outsideHours: true, dialled: 0 });
    expect(dial).not.toHaveBeenCalled();
    expect(fake.tables.callback_requests[0].status).toBe('pending');
  });

  it('skips a do-not-contact customer and waits on a later not_before', async () => {
    setup({}, { do_not_contact_at: '2026-10-01T00:00:00Z' });
    await run();
    expect(fake.tables.callback_requests[0].status).toBe('skipped');
    setup({ not_before: '2026-10-12T11:00:00.000Z' });
    await run();
    expect(dial).not.toHaveBeenCalled();
  });

  it('leaves the request pending while the owner is busy', async () => {
    setup({}, {}, { call_state: 'busy' });
    expect(await run()).toMatchObject({ waiting: 1 });
    expect(dial).not.toHaveBeenCalled();
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('a failed dial goes back to pending, the third marks it failed', async () => {
    dial.mockRejectedValue(new Error('unavailable'));
    setup({ attempts: 1 });
    await run();
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'pending',
      attempts: 2,
    });
    await run();
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
    });
  });

  it('releases a request stuck dialing even outside call-back hours', async () => {
    setup({ status: 'dialing', attempts: 1, updated_at: STALE_AT });
    expect(await run(NIGHT)).toMatchObject({
      outsideHours: true,
      released: 1,
      dialled: 0,
    });
    expect(dial).not.toHaveBeenCalled();
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });

  it('dials a released request again in the same pass', async () => {
    setup({ status: 'dialing', attempts: 1, updated_at: STALE_AT });
    expect(await run()).toMatchObject({ released: 1, dialled: 1 });
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'dialing',
      attempts: 2,
      pbx_call_id: 'pbx-9',
      last_error: null,
    });
  });
});

describe('the call-back call ends (30012)', () => {
  const end = (status: string) => ({
    type: 30012,
    sn: 'SN1',
    msg: {
      call_id: 'pbx-9',
      uid: 'uid-9',
      type: 'Outbound',
      call_from: '1001',
      call_to: '971501234567',
      time_start: '2026-10-12 14:00:00',
      call_duration: 30,
      talk_duration: status === 'ANSWERED' ? 20 : 0,
      status,
    },
  });
  const setup = (attempts = 1) => {
    fake = createFakeDb({
      pbx_connections: [{ id: 'c1', account_id: A, status: 'connected' }],
      pbx_extensions: [
        {
          connection_id: 'c1',
          extension: '1001',
          account_id: A,
          user_id: 'u1',
          presence_monitor: true,
        },
      ],
      callback_requests: [
        {
          id: 'r1',
          account_id: A,
          status: 'dialing',
          pbx_call_id: 'pbx-9',
          attempts,
          task_id: 't1',
        },
      ],
      tasks: [
        {
          id: 't1',
          account_id: A,
          source: 'journey',
          source_ref: 'callback:f1',
          status: 'open',
        },
      ],
    });
  };
  const ingest = (status: string) =>
    ingestPbxEvent({
      db: fake.db,
      connectionId: 'c1',
      payload: end(status),
      receivedAt: '2026-10-12T10:01:00.000Z',
    });

  it('answered: the request is done and its task closed', async () => {
    setup();
    expect((await ingest('ANSWERED')).error).toBeUndefined();
    expect(fake.tables.callback_requests[0].status).toBe('done');
    expect(fake.tables.tasks[0].status).toBe('done');
  });

  it('unanswered: back to pending, or failed at the cap; the task stays open', async () => {
    setup(1);
    await ingest('NO ANSWER');
    expect(fake.tables.callback_requests[0].status).toBe('pending');
    setup(3);
    await ingest('BUSY');
    expect(fake.tables.callback_requests[0].status).toBe('failed');
    expect(fake.tables.tasks[0].status).toBe('open');
  });
});

describe('releaseStaleCallbacks', () => {
  const FRESH_AT = new Date(DAY - STALE_DIALING_MS + 60_000).toISOString();
  const AT_LIMIT = new Date(DAY - STALE_DIALING_MS).toISOString();
  const LOST = 'no result came back from the PBX';
  const setup = (req: Row = {}, tables: Record<string, Row[]> = {}) => {
    fake = createFakeDb({
      callback_requests: [
        {
          id: 'r1',
          account_id: A,
          status: 'dialing',
          attempts: 1,
          pbx_call_id: null,
          task_id: 't1',
          updated_at: STALE_AT,
          ...req,
        },
      ],
      tasks: [
        {
          id: 't1',
          account_id: A,
          source: 'journey',
          source_ref: 'callback:f1',
          status: 'open',
        },
      ],
      ...tables,
    });
  };
  const ended = (status: string) => ({
    calls: [
      {
        id: 'k1',
        account_id: A,
        connection_id: 'c1',
        pbx_call_id: 'pbx-5',
        status,
        ended_at: '2026-10-12T09:00:00.000Z',
      },
    ],
  });
  const release = () => releaseStaleCallbacks(fake.db, DAY);
  const row = () => fake.tables.callback_requests[0];
  /** Changes the request just before the release writes it, as an overlapping run or a late 30012 would. */
  const meanwhile = (change: Row) => {
    const raw = fake.db as unknown as {
      from: (table: string) => { update: (patch: unknown) => unknown };
    };
    const from = raw.from.bind(raw);
    raw.from = (table) => {
      const query = from(table);
      if (table === 'callback_requests') {
        const update = query.update.bind(query);
        query.update = (patch) => {
          Object.assign(row(), change);
          return update(patch);
        };
      }
      return query;
    };
  };

  it('puts a request that never got a call id back to pending, and fails the last attempt', async () => {
    setup();
    expect(await release()).toBe(1);
    // The claim already spent the attempt; releasing spends no more.
    expect(row()).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: LOST,
    });
    setup({ attempts: 3 });
    expect(await release()).toBe(1);
    expect(row()).toMatchObject({ status: 'failed', last_error: LOST });
    expect(fake.tables.tasks[0].status).toBe('open');
  });

  it('treats a call id with no trace as an unanswered attempt', async () => {
    setup({ pbx_call_id: 'pbx-5' });
    expect(await release()).toBe(1);
    expect(row()).toMatchObject({ status: 'pending', last_error: LOST });
    // A call row that never ended says nothing about the result either.
    setup(
      { pbx_call_id: 'pbx-5' },
      {
        calls: [
          {
            id: 'k1',
            account_id: A,
            connection_id: 'c1',
            pbx_call_id: 'pbx-5',
            status: 'ringing',
            ended_at: null,
          },
        ],
      }
    );
    expect(await release()).toBe(1);
    expect(row().status).toBe('pending');
    // Another workspace's call with the same id is not this request's call.
    setup(
      { pbx_call_id: 'pbx-5' },
      {
        call_live: [
          { connection_id: 'c9', account_id: 'other', pbx_call_id: 'pbx-5' },
        ],
        calls: [{ ...ended('answered').calls[0], account_id: 'other' }],
      }
    );
    expect(await release()).toBe(1);
    expect(row().status).toBe('pending');
  });

  it('settles a request whose call ended answered: done, and its task closed', async () => {
    setup({ pbx_call_id: 'pbx-5' }, ended('answered'));
    expect(await release()).toBe(1);
    expect(row()).toMatchObject({ status: 'done', last_error: null });
    expect(fake.tables.tasks[0].status).toBe('done');
  });

  it('settles an unanswered ended call as its 30012 would: pending, failed at the cap, task open', async () => {
    setup({ pbx_call_id: 'pbx-5' }, ended('no_answer'));
    expect(await release()).toBe(1);
    expect(row()).toMatchObject({
      status: 'pending',
      last_error: 'call ended no answer',
    });
    setup({ pbx_call_id: 'pbx-5', attempts: 3 }, ended('busy'));
    expect(await release()).toBe(1);
    expect(row()).toMatchObject({
      status: 'failed',
      last_error: 'call ended busy',
    });
    expect(fake.tables.tasks[0].status).toBe('open');
  });

  it('leaves a request whose call is still in call_live', async () => {
    setup(
      { pbx_call_id: 'pbx-5' },
      {
        call_live: [
          { connection_id: 'c1', account_id: A, pbx_call_id: 'pbx-5' },
        ],
      }
    );
    const before = { ...row() };
    expect(await release()).toBe(0);
    expect(row()).toEqual(before);
  });

  it('leaves a request that is not older than the limit', async () => {
    for (const updated_at of [FRESH_AT, AT_LIMIT]) {
      setup({ updated_at });
      const before = { ...row() };
      expect(await release()).toBe(0);
      expect(row()).toEqual(before);
    }
  });

  describe.each([
    ['no call id', {}, null],
    ['its call ended', { pbx_call_id: 'pbx-5' }, 'answered'],
  ])('%s, changed between the read and the write', (_case, req, status) => {
    it.each([
      [
        're-claimed by an overlapping run',
        { updated_at: FRESH_AT, attempts: 2 },
      ],
      ['settled by a late 30012', { status: 'done' }],
    ])('stays as it was %s', async (_who, change) => {
      setup(req, status ? ended(status) : {});
      meanwhile(change);
      expect(await release()).toBe(0);
      expect(row()).toMatchObject(change);
      expect(row().last_error).toBeUndefined();
      expect(fake.tables.tasks[0].status).toBe('open');
    });
  });
});

describe('retryFailedPbxEvents', () => {
  it('claims each failed event, at most three attempts', async () => {
    fake = createFakeDb({
      pbx_connections: [{ id: 'c1', account_id: A, status: 'connected' }],
      pbx_events_raw: [
        {
          id: 1,
          connection_id: 'c1',
          payload: { type: 1 },
          received_at: '1',
          processed_at: null,
          error: 'boom',
          attempts: 2,
        },
        {
          id: 2,
          connection_id: 'c1',
          payload: { type: 1 },
          received_at: '2',
          processed_at: null,
          error: 'boom',
          attempts: 3,
        },
        {
          id: 3,
          connection_id: 'c1',
          payload: { type: 1 },
          received_at: '3',
          processed_at: null,
          error: null,
          attempts: 0,
        },
      ],
    });
    expect(await retryFailedPbxEvents({ db: fake.db })).toMatchObject({
      retried: 1,
    });
    expect(fake.tables.pbx_events_raw.map((r) => r.attempts)).toEqual([
      3, 3, 0,
    ]);
    expect(await retryFailedPbxEvents({ db: fake.db })).toMatchObject({
      retried: 0,
    });
  });
});
