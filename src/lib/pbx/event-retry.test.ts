import { describe, expect, it } from 'vitest';

import {
  dueForRetry,
  INTERRUPTED_AFTER_MS,
  LATE_AFTER_MS,
  LIVE_STATE_MAX_AGE_MS,
  retryDecision,
  retryStateRow,
  RETRY_SKIP,
} from './event-retry';
import { parseYeastarEvent, type YeastarEvent } from './yeastar/events';

const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const parsed = (frame: object): YeastarEvent => {
  const r = parseYeastarEvent(frame);
  if (!r.ok) throw new Error(r.error);
  return r.event;
};
const ext = (number: string, member_status: string) => ({
  extension: { number, channel_id: `ch-${number}`, member_status },
});
const state = (...members: object[]) =>
  parsed({ type: 30011, sn: 'S', msg: { call_id: 'K1', members } });
/** Dubai wall clock (UTC+4): 14:00 there is NOW. */
const end = (time_start: string, call_duration = 30) =>
  parsed({
    type: 30012,
    sn: 'S',
    msg: {
      call_id: 'K1',
      uid: 'U1',
      type: 'Inbound',
      call_from: '0501234567',
      call_to: '6300',
      time_start,
      call_duration,
      talk_duration: 0,
      status: 'NO ANSWER',
    },
  });
const registration = parsed({
  type: 30007,
  sn: 'S',
  msg: { extension: '1001', status: 'registered', kind: 'mobile' },
});
const presence = parsed({
  type: 30009,
  sn: 'S',
  msg: { extension: '1001', status: 'available' },
});
const decide = (
  event: YeastarEvent | null,
  ageMs: number,
  stateUpdatedAt: string | null = null
) =>
  retryDecision({ event, receivedAt: ago(ageMs), stateUpdatedAt, nowMs: NOW });

const RUN = { run: true, late: false };
const LATE = { run: true, late: true };

describe('dueForRetry', () => {
  const due = (ageMs: number, error: string | null) =>
    dueForRetry({ received_at: ago(ageMs), error }, NOW);

  it('takes a failed row at once, one with no outcome after two minutes', () => {
    expect(due(0, 'boom')).toBe(true);
    expect(due(INTERRUPTED_AFTER_MS, null)).toBe(false);
    expect(due(INTERRUPTED_AFTER_MS + 1, null)).toBe(true);
  });
});

describe('retryDecision', () => {
  it('runs a recent call end in full', () => {
    expect(decide(end('2026-10-12 13:50:00'), 5 * MIN)).toEqual(RUN);
  });

  it('is late for an end received over an hour ago', () => {
    const recent = end('2026-10-12 13:50:00');
    expect(decide(recent, LATE_AFTER_MS)).toEqual(RUN);
    expect(decide(recent, LATE_AFTER_MS + 1)).toEqual(LATE);
  });

  it('is late for a just-received end whose call ended over an hour ago (an interrupted import)', () => {
    expect(decide(end('2026-10-12 11:00:00'), 3 * MIN)).toEqual(LATE);
    // Judged by the call's end, not its start: 90 minutes long.
    expect(decide(end('2026-10-12 12:10:00', 90 * 60), 3 * MIN)).toEqual(RUN);
  });

  it('is late for an end whose time cannot be read', () => {
    expect(decide(end('soon'), 3 * MIN)).toEqual(LATE);
  });

  it('never runs an old ring, presence or registration', () => {
    const ringing = state(ext('1001', 'RING'));
    for (const ev of [ringing, presence, registration]) {
      expect(decide(ev, LIVE_STATE_MAX_AGE_MS)).toEqual(RUN);
      expect(decide(ev, LIVE_STATE_MAX_AGE_MS + 1)).toEqual({
        run: false,
        reason: RETRY_SKIP.oldState,
      });
      expect(decide(ev, LATE_AFTER_MS + 1)).toEqual({
        run: false,
        reason: RETRY_SKIP.late,
      });
    }
  });

  it('takes anyone still ringing as ringing', () => {
    const transfer = state(ext('1001', 'ANSWER'), ext('1002', 'RING'));
    expect(decide(transfer, 5 * MIN)).toMatchObject({ run: false });
    expect(decide(state(ext('1001', 'ANSWER')), 5 * MIN)).toEqual(RUN);
  });

  it('never overwrites a row written since the event came in', () => {
    for (const ev of [state(ext('1001', 'ANSWER')), presence, registration]) {
      expect(decide(ev, 30_000, ago(29_000))).toEqual({
        run: false,
        reason: RETRY_SKIP.superseded,
      });
      // Its own first run wrote the row at the receive time.
      expect(decide(ev, 30_000, ago(30_000))).toEqual(RUN);
    }
  });

  it('always applies an all-BYE frame', () => {
    const bye = state(ext('1001', 'BYE'), ext('1002', 'bye'));
    expect(decide(bye, 5 * MIN, ago(0))).toEqual(RUN);
    expect(decide(bye, 2 * LATE_AFTER_MS, ago(0))).toEqual(LATE);
  });

  it('runs a frame it cannot parse, late once old', () => {
    expect(decide(null, 5 * MIN)).toEqual(RUN);
    expect(decide(null, LATE_AFTER_MS + 1)).toEqual(LATE);
  });
});

describe('retryStateRow', () => {
  it('names the row each kind overwrites', () => {
    expect(retryStateRow(state(ext('1001', 'RING')))).toEqual({
      table: 'call_live',
      column: 'pbx_call_id',
      value: 'K1',
    });
    expect(retryStateRow(presence)?.table).toBe('pbx_presence');
    expect(retryStateRow(registration)?.table).toBe('pbx_extensions');
    expect(retryStateRow(state(ext('1001', 'BYE')))).toBeNull();
    expect(retryStateRow(end('2026-10-12 13:50:00'))).toBeNull();
  });
});
