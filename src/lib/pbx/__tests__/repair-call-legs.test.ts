import { describe, expect, it } from 'vitest';

import { planCallRepair, type RepairRow } from '../call-repair';
import type { CallEndEvent } from '../yeastar/events';

const T0 = Date.parse('2026-10-27T10:47:26.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (
  uid: string,
  status: string,
  start: number,
  o: Partial<CallEndEvent> = {}
) =>
  ({
    kind: 'call_end',
    type: 30012,
    callId: 'c1',
    uid,
    direction: 'inbound',
    from: '971500000000',
    to: '101',
    startedAt: at(start),
    startedAtRaw: null,
    callSeconds: 20,
    talkSeconds: 0,
    status,
    raw: {},
    ...o,
  }) as CallEndEvent;

const row = (o: Partial<RepairRow> = {}): RepairRow => ({
  id: 'r1',
  direction: 'inbound',
  status: 'failed',
  talk_seconds: 0,
  ring_seconds: 0,
  started_at: at(24),
  ended_at: at(30),
  answered_at: null,
  extension: null,
  user_id: null,
  pbx_uid: 'u2',
  meta: {},
  ...o,
});

const exts = new Map([['102', { user_id: 'user-102' }]]);

describe('planCallRepair', () => {
  it('lets an answered leg win over the last record and fills user_id', () => {
    const plan = planCallRepair(
      row(),
      [
        ev('u1', 'NO ANSWER', 0, { to: '101' }),
        ev('u2', 'ANSWERED', 5, {
          to: '102',
          callSeconds: 60,
          talkSeconds: 50,
        }),
        ev('u3', 'FAILED', 24),
      ],
      exts
    )!;
    expect(plan.changed).toBe(true);
    expect(plan.answered).toBe(true);
    expect(plan.patch.status).toBe('answered');
    expect(plan.patch.talk_seconds).toBe(50);
    expect(plan.patch.started_at).toBe(at(0));
    expect(plan.patch.extension).toBe('102');
    expect(plan.patch.user_id).toBe('user-102');
    expect((plan.patch.meta.cdr_legs as unknown[]).length).toBe(3);
  });

  it('keeps an existing user_id and reports no change on a second pass', () => {
    const events = [ev('u1', 'NO ANSWER', 0), ev('u2', 'FAILED', 24)];
    const first = planCallRepair(row({ user_id: 'someone' }), events, exts)!;
    expect(first.patch.user_id).toBe('someone');
    expect(first.patch.status).toBe('no_answer');
    const again = planCallRepair(
      row({
        status: first.patch.status,
        talk_seconds: first.patch.talk_seconds,
        ring_seconds: first.patch.ring_seconds,
        started_at: first.patch.started_at,
        ended_at: first.patch.ended_at,
        answered_at: first.patch.answered_at,
        extension: first.patch.extension,
        user_id: first.patch.user_id,
        pbx_uid: first.patch.pbx_uid,
        meta: first.patch.meta,
      }),
      events,
      exts
    )!;
    expect(again.changed).toBe(false);
  });

  it('plans nothing without events', () => {
    expect(planCallRepair(row(), [], exts)).toBeNull();
  });
});
