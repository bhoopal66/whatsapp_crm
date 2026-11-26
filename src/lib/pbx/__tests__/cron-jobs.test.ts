import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CALLBACK_WAIT_MS,
  dialDueCallbacks,
  inCallbackHours,
  releaseStaleCallbacks,
  retryNotBefore,
  settleCallbackCall,
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
const HOUR = 3_600_000;
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

  it('keeps what a call end wrote to meta during the download', async () => {
    const downloadDuring = async (answer: () => Response) => {
      fake = createFakeDb({ calls: [call('k1')] });
      const out = await fetchPendingRecordings({
        db: fake.db,
        apiFor: handle({ recordingDownloadUrl: async () => 'https://pbx/x' }),
        fetch: async () => {
          Object.assign(fake.tables.calls[0], {
            meta: { cdr_legs: ['leg'] },
            updated_at: 'k1-later',
          });
          return answer();
        },
      });
      return { out, row: fake.tables.calls[0] };
    };
    const ok = await downloadDuring(audio);
    expect(ok.out).toMatchObject({ fetched: 1, failed: 0 });
    expect(ok.row).toMatchObject({
      recording_state: 'fetched',
      meta: { cdr_legs: ['leg'], announcement_basis: 'pbx_prompt' },
    });
    const bad = await downloadDuring(() => new Response('', { status: 500 }));
    expect(bad.out).toMatchObject({ fetched: 0, failed: 1 });
    expect(bad.row).toMatchObject({
      recording_state: 'pending',
      meta: { cdr_legs: ['leg'], recording_attempts: 1 },
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
  const run = (now = DAY, limit?: number) =>
    dialDueCallbacks({
      db: fake.db,
      now: () => now,
      limit,
      apiFor: handle({ dial }),
    });
  const req = (id = 'r1') =>
    fake.tables.callback_requests.find((r) => r.id === id)!;
  const iso = (ms: number) => new Date(ms).toISOString();
  const refused = () =>
    new YeastarError({
      endpoint: 'call/dial',
      errcode: 60003,
      errmsg: 'CALLER UNAVAILABLE',
    });
  const timeout = (endpoint: string) =>
    new YeastarError({ endpoint, errcode: null, errmsg: 'TIMEOUT' });
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
    dial.mockRejectedValue(refused());
    setup({ attempts: 1 });
    expect(await run()).toMatchObject({ waiting: 1, uncertain: 0 });
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'pending',
      attempts: 2,
      not_before: iso(DAY + 2 * HOUR),
    });
    // Not before its back-off.
    await run(DAY + 2 * HOUR - 1);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(await run(DAY + 2 * HOUR)).toMatchObject({ failed: 1 });
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

  describe('with calling from the CRM switched off', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('never dials: a due request is skipped, at any hour, and its task left alone', async () => {
      vi.stubEnv('NEXT_PUBLIC_PBX_OUTBOUND_CALLS', '');
      for (const at of [DAY, NIGHT]) {
        setup();
        fake.tables.tasks = [{ id: 't1', account_id: A, status: 'open' }];
        expect(await run(at)).toMatchObject({
          outsideHours: false,
          dialled: 0,
          skipped: 1,
        });
        expect(fake.tables.callback_requests[0]).toMatchObject({
          status: 'skipped',
          attempts: 0,
          last_error: 'outbound_calls_off',
        });
        expect(fake.tables.tasks[0].status).toBe('open');
      }
      expect(dial).not.toHaveBeenCalled();
    });

    it('leaves a request that is not due yet', async () => {
      vi.stubEnv('NEXT_PUBLIC_PBX_OUTBOUND_CALLS', 'off');
      setup({ not_before: '2026-10-12T11:00:00.000Z' });
      expect(await run()).toMatchObject({ skipped: 0, dialled: 0 });
      expect(fake.tables.callback_requests[0].status).toBe('pending');
    });

    it('still releases a request stuck dialing, then skips it once it is due', async () => {
      vi.stubEnv('NEXT_PUBLIC_PBX_OUTBOUND_CALLS', '');
      setup({ status: 'dialing', attempts: 1, updated_at: STALE_AT });
      expect(await run()).toMatchObject({
        released: 1,
        skipped: 0,
        dialled: 0,
      });
      expect(await run(DAY + HOUR / 2)).toMatchObject({ skipped: 1 });
      expect(dial).not.toHaveBeenCalled();
      expect(fake.tables.callback_requests[0]).toMatchObject({
        status: 'skipped',
        attempts: 1,
      });
    });
  });

  it('dials a released request again half an hour later, not in the same pass', async () => {
    setup({
      status: 'dialing',
      attempts: 1,
      updated_at: STALE_AT,
      pbx_call_id: 'pbx-5',
    });
    expect(await run()).toMatchObject({ released: 1, dialled: 0 });
    expect(req()).toMatchObject({
      status: 'pending',
      not_before: iso(DAY + HOUR / 2),
    });
    expect(await run(DAY + HOUR / 2)).toMatchObject({ dialled: 1 });
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'dialing',
      attempts: 2,
      pbx_call_id: 'pbx-9',
      last_error: null,
    });
  });

  describe('one customer is not rung twice', () => {
    const other = (r: Row = {}) => ({
      id: 'r2',
      account_id: A,
      contact_id: 'ct1',
      status: 'pending',
      not_before: null,
      assigned_to: 'u2',
      attempts: 0,
      created_at: '2',
      ...r,
    });
    /** A second person, free to dial, so only the customer is in the way. */
    const secondOwner = () => {
      fake.tables.pbx_extensions.push({
        connection_id: 'c1',
        extension: '1002',
        account_id: A,
        user_id: 'u2',
        registration_state: 'registered',
      });
      fake.tables.pbx_presence.push({
        connection_id: 'c1',
        extension: '1002',
        presence: 'available',
        call_state: 'idle',
      });
    };
    const called = (r: Row = {}) => ({
      id: 'k1',
      account_id: A,
      direction: 'outbound',
      remote_number: '971501234567',
      started_at: iso(DAY - 10 * 60_000),
      ...r,
    });

    it('dials one of two requests of a contact; the other waits', async () => {
      setup();
      secondOwner();
      fake.tables.callback_requests.push(other());
      expect(await run()).toMatchObject({ dialled: 1, waiting: 1 });
      expect(dial).toHaveBeenCalledTimes(1);
      expect(req('r1').status).toBe('dialing');
      expect(req('r2')).toMatchObject({
        status: 'pending',
        attempts: 0,
        not_before: iso(DAY + CALLBACK_WAIT_MS),
      });
    });

    it('does not let two waiting requests, or another customer’s, block each other', async () => {
      setup({ not_before: iso(DAY - 1) });
      fake.tables.callback_requests.push(
        other({ not_before: iso(DAY + 60_000), updated_at: iso(DAY) }),
        other({ id: 'r3', contact_id: 'ct9', status: 'dialing' }),
        other({ id: 'r4', account_id: 'other', status: 'dialing' })
      );
      expect(await run()).toMatchObject({ dialled: 1 });
    });

    it('waits half an hour from any outbound call to the number', async () => {
      setup();
      fake.tables.calls = [called({ remote_number: '9710501234567' })];
      expect(await run()).toMatchObject({ dialled: 0, waiting: 1 });
      expect(req()).toMatchObject({
        status: 'pending',
        attempts: 0,
        not_before: iso(DAY + 20 * 60_000),
      });
      // Seen before the claim: a wait never shows as a dial.
      expect(fake.log).not.toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ status: 'dialing' }),
        })
      );
      expect(await run(DAY + 20 * 60_000)).toMatchObject({ dialled: 1 });
    });

    it.each([
      ['inbound', { direction: 'inbound' }],
      ['to another number', { remote_number: '971509999999' }],
      ['in another workspace', { account_id: 'other' }],
      ['half an hour old', { started_at: iso(DAY - HOUR / 2) }],
    ])('is not held by a call %s', async (_what, over) => {
      setup();
      fake.tables.calls = [called(over)];
      expect(await run()).toMatchObject({ dialled: 1 });
    });

    it('two overlapping passes never ring both requests of a contact', async () => {
      setup();
      secondOwner();
      fake.tables.callback_requests.push(other());
      // Both passes look before either claims: the fake answers each query
      // in turn, so running them together interleaves them step by step.
      const second = createView(fake, ['r2']);
      const first = createView(fake, ['r1']);
      const pass = (db: FakeDb['db']) =>
        dialDueCallbacks({ db, now: () => DAY, apiFor: handle({ dial }) });
      await Promise.all([pass(first), pass(second)]);
      expect(dial.mock.calls.length).toBeLessThanOrEqual(1);
      const waiting = fake.tables.callback_requests.filter(
        (r) => r.status === 'pending'
      );
      expect(waiting.length).toBeGreaterThan(0);
      for (const r of waiting)
        expect(r).toMatchObject({
          attempts: 0,
          not_before: iso(DAY + CALLBACK_WAIT_MS),
        });
    });

    /** The database, whose due list shows only these requests. */
    function createView(f: FakeDb, ids: string[]): FakeDb['db'] {
      type Q = {
        or: (e: string) => Q;
        in: (c: string, v: unknown[]) => Q;
      };
      const raw = f.db as unknown as { from: (t: string) => Q };
      return {
        ...(raw as object),
        from: (t: string) => {
          const q = raw.from(t);
          const or = q.or.bind(q);
          q.or = (e) => or(e).in('id', ids);
          return q;
        },
      } as unknown as FakeDb['db'];
    }
  });

  describe('a dial with no clear answer', () => {
    it.each([
      ['a timeout', timeout('call/dial')],
      ['an unknown error', new Error('socket hang up')],
    ])('%s leaves the request dialing', async (_what, err) => {
      dial.mockRejectedValue(err);
      setup({ attempts: 2, pbx_call_id: 'pbx-old' });
      expect(await run()).toMatchObject({
        dialled: 0,
        failed: 0,
        waiting: 0,
        uncertain: 1,
      });
      expect(req()).toMatchObject({
        status: 'dialing',
        attempts: 3,
        // The earlier attempt's call can no longer settle this one.
        pbx_call_id: null,
      });
      expect(req().last_error).toContain(err.message);
      await run(DAY + 60_000);
      expect(dial).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an error code', refused()],
      ['the token fetch', timeout('get_token')],
      ['our own connection', new PbxConnectionError('auth_backoff', 'wait')],
    ])('%s is a definite refusal', async (_what, err) => {
      dial.mockRejectedValue(err);
      setup();
      expect(await run()).toMatchObject({ waiting: 1, uncertain: 0 });
      expect(req()).toMatchObject({
        status: 'pending',
        not_before: iso(DAY + HOUR / 2),
      });
    });

    it('a database error after the dial does not undo the claim', async () => {
      setup();
      dial.mockImplementation(async () => {
        fake.fail('callback_requests', 'update', { message: 'down' });
        return { callId: 'pbx-9' };
      });
      expect(await run()).toMatchObject({ dialled: 1, waiting: 0 });
      expect(req()).toMatchObject({ status: 'dialing', pbx_call_id: null });
    });
  });

  describe('a request that cannot be dialled now', () => {
    const behind = () =>
      fake.tables.callback_requests.push({
        id: 'r2',
        account_id: A,
        contact_id: 'ct2',
        status: 'pending',
        not_before: null,
        assigned_to: 'u2',
        attempts: 0,
        created_at: '2',
      });
    const other = () => {
      behind();
      fake.tables.contacts.push({
        id: 'ct2',
        account_id: A,
        phone: '971507654321',
        do_not_contact_at: null,
        user_id: 'u2',
      });
      fake.tables.pbx_extensions.push({
        connection_id: 'c1',
        extension: '1002',
        account_id: A,
        user_id: 'u2',
        registration_state: 'registered',
      });
      fake.tables.pbx_presence.push({
        connection_id: 'c1',
        extension: '1002',
        presence: 'available',
        call_state: 'idle',
      });
    };

    it('lets the ones behind it past, then comes round again', async () => {
      setup({}, {}, { call_state: 'busy' });
      other();
      await run(DAY, 1);
      expect(req('r1')).toMatchObject({
        status: 'pending',
        not_before: iso(DAY + CALLBACK_WAIT_MS),
      });
      expect(await run(DAY + 60_000, 1)).toMatchObject({ dialled: 1 });
      expect(req('r2').status).toBe('dialing');
      fake.tables.pbx_presence[0].call_state = 'idle';
      expect(await run(DAY + CALLBACK_WAIT_MS, 1)).toMatchObject({
        dialled: 1,
      });
      expect(req('r1').status).toBe('dialing');
    });

    it('goes behind one that has waited longer', async () => {
      setup({ not_before: iso(DAY - 1000) });
      other();
      req('r2').not_before = iso(DAY - 2000);
      await run(DAY, 1);
      expect(req('r1').status).toBe('pending');
      expect(req('r2').status).toBe('dialing');
    });

    it('waits while the PBX is backing off', async () => {
      setup();
      await dialDueCallbacks({
        db: fake.db,
        now: () => DAY,
        apiFor: async () => {
          throw new PbxConnectionError('auth_backoff', 'wait');
        },
      });
      expect(req()).toMatchObject({
        status: 'pending',
        attempts: 0,
        not_before: iso(DAY + CALLBACK_WAIT_MS),
      });
    });

    it('is skipped with no owner, or an owner with no extension', async () => {
      setup({}, { user_id: null });
      expect(await run()).toMatchObject({ skipped: 1, waiting: 0 });
      expect(req()).toMatchObject({
        status: 'skipped',
        last_error: 'no owner to call from',
      });
      setup({ assigned_to: 'u9' });
      expect(await run()).toMatchObject({ skipped: 1, waiting: 0 });
      expect(req()).toMatchObject({
        status: 'skipped',
        last_error: 'the owner has no extension in this workspace',
      });
    });
  });

  describe('the number', () => {
    it.each(['050 123 4567', '00971501234567', '+971 (0)50 123 4567'])(
      'dials %s in its full form',
      async (phone) => {
        setup({}, { phone });
        await run();
        expect(dial).toHaveBeenCalledWith({
          caller: '1001',
          callee: '971501234567',
        });
      }
    );

    it.each([null, 'unknown', '205'])('never dials %s', async (phone) => {
      setup({}, { phone });
      expect(await run()).toMatchObject({ failed: 1 });
      expect(dial).not.toHaveBeenCalled();
      expect(req().status).toBe('failed');
    });

    it('skips a number another do-not-contact customer holds, however saved', async () => {
      setup();
      fake.tables.contacts.push({
        id: 'ct2',
        account_id: A,
        phone_normalized: '0501234567',
        do_not_contact_at: '2026-10-01T00:00:00Z',
      });
      expect(await run()).toMatchObject({ skipped: 1 });
      expect(dial).not.toHaveBeenCalled();
      expect(req()).toMatchObject({
        status: 'skipped',
        last_error: 'do_not_contact',
      });
    });
  });
});

describe('retryNotBefore', () => {
  it('waits half an hour after the first attempt and two hours after the second', () => {
    const after = (attempts: number) =>
      Date.parse(retryNotBefore(attempts, DAY)) - DAY;
    expect(after(1)).toBe(HOUR / 2);
    expect(after(2)).toBe(2 * HOUR);
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
    expect(
      Date.parse(String(fake.tables.callback_requests[0].not_before))
    ).toBeGreaterThan(Date.now() + HOUR / 2 - 60_000);
    setup(2);
    await settleCallbackCall(fake.db, {
      accountId: A,
      pbxCallId: 'pbx-9',
      answered: false,
      status: 'NO ANSWER',
      now: () => DAY,
    });
    expect(fake.tables.callback_requests[0]).toMatchObject({
      status: 'pending',
      not_before: new Date(DAY + 2 * HOUR).toISOString(),
    });
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
      not_before: retryNotBefore(1, DAY),
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
      not_before: retryNotBefore(1, DAY),
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
  const ago = (ms: number) => new Date(DAY - ms).toISOString();
  const MIN = 60_000;
  const raw = (id: number, ageMs: number, r: Row = {}): Row => ({
    id,
    connection_id: 'c1',
    payload: { type: 1 },
    received_at: ago(ageMs),
    processed_at: null,
    error: null,
    attempts: 0,
    ...r,
  });
  const setup = (events: Row[], tables: Record<string, Row[]> = {}) => {
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
      profiles: [
        {
          user_id: 'u1',
          account_id: A,
          account_role: 'agent',
          deactivated_at: null,
        },
      ],
      pbx_events_raw: events,
      ...tables,
    });
  };
  const retry = (limit?: number) =>
    retryFailedPbxEvents({ db: fake.db, now: () => DAY, limit });
  const ring = (status: string) => ({
    type: 30011,
    msg: {
      call_id: 'K1',
      members: [
        {
          inbound: {
            from: '0501234567',
            to: '043334444',
            channel_id: 'in-1',
            member_status: 'RING',
          },
        },
        {
          extension: {
            number: '1001',
            channel_id: 'ch-1001',
            member_status: status,
          },
        },
      ].map((m) =>
        status === 'BYE' && m.inbound
          ? { inbound: { ...m.inbound, member_status: 'BYE' } }
          : m
      ),
    },
  });
  // Dubai wall clock: DAY is 14:00 there.
  const missed = (time: string) => ({
    type: 30012,
    msg: {
      call_id: 'K1',
      uid: 'U1',
      type: 'Inbound',
      call_from: '0501234567',
      call_to: '1001',
      time_start: `2026-10-12 ${time}`,
      call_duration: 30,
      talk_duration: 0,
      status: 'NO ANSWER',
    },
  });

  it('claims each failed or interrupted event, at most three attempts', async () => {
    setup([
      raw(1, 1_000, { error: 'boom', attempts: 2 }),
      raw(2, 1_000, { error: 'boom', attempts: 3 }),
      // Interrupted before its stamp; the next may still be running.
      raw(3, 3 * MIN),
      raw(4, MIN),
    ]);
    expect(await retry()).toMatchObject({ retried: 2, recovered: 2 });
    expect(fake.tables.pbx_events_raw.map((r) => r.attempts)).toEqual([
      3, 3, 1, 0,
    ]);
    expect(fake.tables.pbx_events_raw[2].processed_at).not.toBeNull();
    expect(await retry()).toMatchObject({ retried: 0 });
  });

  it('takes events under an hour old before a backlog of older ones', async () => {
    setup([
      raw(1, 90 * MIN, { payload: ring('RING') }),
      raw(2, 80 * MIN, { payload: ring('RING') }),
      raw(3, 5 * MIN),
    ]);
    await retry(2);
    expect(fake.tables.pbx_events_raw.map((r) => r.attempts)).toEqual([
      1, 0, 1,
    ]);
  });

  it('files an interrupted missed call once', async () => {
    setup([raw(1, 5 * MIN, { payload: missed('13:54:00') })]);
    await retry();
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.notifications).toHaveLength(1);
    // Stored again, as the second run of one whose stamp was lost.
    Object.assign(fake.tables.pbx_events_raw[0], { processed_at: null });
    await retry();
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.notifications).toHaveLength(1);
  });

  it('only records a call that ended over an hour ago', async () => {
    setup(
      [
        raw(1, 90 * MIN, { payload: missed('12:29:00') }),
        // A historical ingest (CDR import) interrupted: received just now.
        raw(2, 3 * MIN, {
          payload: {
            ...missed('11:00:00'),
            msg: { ...missed('11:00:00').msg, call_id: 'K2', uid: 'U2' },
          },
        }),
      ],
      {
        call_live: [
          { connection_id: 'c1', pbx_call_id: 'K1', ringing_user_ids: [] },
        ],
      }
    );
    expect(await retry()).toMatchObject({ retried: 2, recovered: 2 });
    expect(fake.tables.calls.map((c) => [c.pbx_call_id, c.status])).toEqual([
      ['K2', 'no_answer'],
      ['K1', 'no_answer'],
    ]);
    expect(fake.tables.call_live).toEqual([]);
    expect(fake.tables.tasks ?? []).toEqual([]);
    expect(fake.tables.notifications ?? []).toEqual([]);
    expect(fake.tables.pbx_connections[0].last_event_at).toBeUndefined();
  });

  it('keeps a late call end that failed for the next attempt', async () => {
    setup([raw(1, 90 * MIN, { payload: missed('12:29:00') })]);
    fake.fail('calls', 'upsert', { message: 'down' });
    expect(await retry()).toMatchObject({ retried: 1, recovered: 0 });
    expect(fake.tables.pbx_events_raw[0]).toMatchObject({
      processed_at: null,
      attempts: 1,
    });
    expect(await retry()).toMatchObject({ retried: 1, recovered: 1 });
  });

  it('stamps an old ring without ringing anyone', async () => {
    setup([raw(1, 3 * MIN, { payload: ring('RING') })]);
    expect(await retry()).toMatchObject({ retried: 0, skipped: 1 });
    expect(fake.tables.call_live ?? []).toEqual([]);
    expect(fake.tables.pbx_events_raw[0]).toMatchObject({
      processed_at: new Date(DAY).toISOString(),
      error: expect.stringContaining('not retried'),
    });
  });

  it('never turns an answered call back to ringing', async () => {
    setup([raw(1, 30_000, { error: 'boom', payload: ring('RING') })], {
      call_live: [
        {
          connection_id: 'c1',
          pbx_call_id: 'K1',
          state: 'answered',
          updated_at: ago(20_000),
        },
      ],
    });
    expect(await retry()).toMatchObject({ retried: 0, skipped: 1 });
    expect(fake.tables.call_live[0].state).toBe('answered');
  });

  it('clears the screen pop of a call that hung up, however old', async () => {
    setup([raw(1, 90 * MIN, { payload: ring('BYE') })], {
      call_live: [
        { connection_id: 'c1', pbx_call_id: 'K1', updated_at: ago(0) },
      ],
    });
    expect(await retry()).toMatchObject({ recovered: 1 });
    expect(fake.tables.call_live).toEqual([]);
    expect(fake.tables.pbx_connections[0].last_event_at).toBeUndefined();
  });

  it('spends no attempt when the row it would overwrite cannot be read', async () => {
    setup([raw(1, 30_000, { error: 'boom', payload: ring('ANSWER') })]);
    fake.fail('call_live', 'select', { message: 'down' });
    await expect(retry()).rejects.toThrow('call_live read failed');
    expect(fake.tables.pbx_events_raw[0].attempts).toBe(0);
  });
});
