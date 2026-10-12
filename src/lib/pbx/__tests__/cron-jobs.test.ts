import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dialDueCallbacks, inCallbackHours } from '../callbacks';
import type { PbxHandle } from '../connection';
import { PbxConnectionError } from '../connection';
import { retryFailedPbxEvents } from '../housekeeping';
import { ingestPbxEvent } from '../process';
import { fetchPendingRecordings } from '../recordings';
import { YeastarError } from '../yeastar/errors';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

const A = 'acc';
// 14:00 in Dubai (UTC+4); 21:00 Dubai is 17:00Z.
const DAY = Date.parse('2026-10-12T10:00:00.000Z');
const NIGHT = Date.parse('2026-10-12T17:00:00.000Z');
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
