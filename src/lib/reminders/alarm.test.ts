import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/types';

import {
  ALARM_CHIME_FRESH_MS,
  ALARM_MAX_AGE_MS,
  ALARM_MAX_CHIMES,
  ALARM_MAX_VISIBLE,
  ALARM_REPEAT_MS,
  AlarmQueue,
  SNOOZE_OPTIONS,
  alarmFor,
  flashTitle,
  snoozeUntil,
  visibleAlarms,
} from './alarm';

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const TASK = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const MEETING = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '55555555-5555-4555-8555-555555555555';

let seq = 0;
function row(over: Partial<Notification> = {}): Notification {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    account_id: ACCOUNT,
    user_id: 'u1',
    type: 'task_due',
    title: 'Call Ahmed',
    body: 'Due now · 10:00',
    meta: { task_id: TASK, offset: 0 },
    created_at: new Date(NOW).toISOString(),
    ...over,
  };
}
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('alarmFor', () => {
  it('rings a task falling due, with its ids', () => {
    const r = row({ contact_id: CONTACT });
    const a = alarmFor(r, NOW);
    expect(a).toMatchObject({
      id: r.id,
      kind: 'task',
      title: 'Call Ahmed',
      body: 'Due now · 10:00',
      accountId: ACCOUNT,
      taskId: TASK,
      eventId: null,
      meetingId: null,
      contactId: CONTACT,
      conversationId: null,
      createdAt: NOW,
      offset: 0,
      missed: false,
    });
    expect(a?.row).toBe(r);
  });

  it('leaves the 15-minute heads-up and an offset-less task_due to the bell', () => {
    expect(alarmFor(row({ meta: { task_id: TASK, offset: 15 } }), NOW)).toBe(
      null
    );
    expect(alarmFor(row({ meta: { task_id: TASK } }), NOW)).toBe(null);
    expect(alarmFor(row({ meta: { task_id: TASK, offset: '0' } }), NOW)).toBe(
      null
    );
  });

  it('needs a uuid id for each type', () => {
    expect(alarmFor(row({ meta: { task_id: 'x', offset: 0 } }), NOW)).toBe(
      null
    );
    expect(
      alarmFor(row({ type: 'meeting_reminder', meta: { offset: 0 } }), NOW)
    ).toBe(null);
    expect(
      alarmFor(
        row({ type: 'event_reminder', meta: { meeting_id: MEETING } }),
        NOW
      )
    ).toBe(null);
  });

  it('rings meeting reminders, with or without an offset', () => {
    const ten = alarmFor(
      row({
        type: 'meeting_reminder',
        meta: { meeting_id: MEETING, offset: 10 },
      }),
      NOW
    );
    expect(ten).toMatchObject({
      kind: 'meeting',
      meetingId: MEETING,
      offset: 10,
    });
    const old = alarmFor(
      row({ type: 'meeting_reminder', meta: { meeting_id: MEETING } }),
      NOW
    );
    expect(old).toMatchObject({ kind: 'meeting', offset: null, taskId: null });
  });

  it('rings an event reminder at any offset', () => {
    const a = alarmFor(
      row({
        type: 'event_reminder',
        meta: { event_id: EVENT, occurrence_start: ago(0), offset: 30 },
      }),
      NOW
    );
    expect(a).toMatchObject({ kind: 'event', eventId: EVENT, offset: 30 });
  });

  it('ignores read rows, other types and rows over two hours old', () => {
    expect(alarmFor(row({ read_at: ago(0) }), NOW)).toBe(null);
    expect(alarmFor(row({ type: 'task_assigned' }), NOW)).toBe(null);
    expect(alarmFor(row({ created_at: ago(ALARM_MAX_AGE_MS) }), NOW)).not.toBe(
      null
    );
    expect(alarmFor(row({ created_at: ago(ALARM_MAX_AGE_MS + 1) }), NOW)).toBe(
      null
    );
    expect(alarmFor(row({ created_at: 'nonsense' }), NOW)).toBe(null);
  });
});

describe('AlarmQueue', () => {
  let chime: ReturnType<typeof vi.fn<(id: string, n: number) => void>>;
  let queue: AlarmQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    chime = vi.fn<(id: string, n: number) => void>();
    queue = new AlarmQueue({ chime });
  });

  afterEach(() => {
    queue.close();
    vi.useRealTimers();
  });

  it('an insert shows and chimes; a duplicate insert changes nothing', () => {
    const listener = vi.fn();
    queue.subscribe(listener);
    const r = row();
    queue.handle({ type: 'insert', row: r });
    expect(queue.getSnapshot().map((a) => a.id)).toEqual([r.id]);
    expect(chime).toHaveBeenCalledWith(r.id, 0);
    expect(listener).toHaveBeenCalledTimes(1);

    const before = queue.getSnapshot();
    queue.handle({ type: 'insert', row: r });
    expect(queue.getSnapshot()).toBe(before);
    expect(chime).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('an insert that is not an alarm is ignored', () => {
    queue.handle({
      type: 'insert',
      row: row({ meta: { task_id: TASK, offset: 15 } }),
    });
    expect(queue.getSnapshot()).toEqual([]);
    expect(chime).not.toHaveBeenCalled();
  });

  it('repeats every minute, at most three chimes', () => {
    const r = row();
    queue.handle({ type: 'insert', row: r });
    vi.advanceTimersByTime(ALARM_REPEAT_MS - 1);
    expect(chime).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(chime).toHaveBeenLastCalledWith(r.id, 1);
    vi.advanceTimersByTime(ALARM_REPEAT_MS * 10);
    expect(chime).toHaveBeenCalledTimes(ALARM_MAX_CHIMES);
    expect(chime).toHaveBeenLastCalledWith(r.id, ALARM_MAX_CHIMES - 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.getSnapshot()).toHaveLength(1);
  });

  it('read elsewhere (an UPDATE with read_at) removes it and stops the chime', () => {
    const r = row();
    queue.handle({ type: 'insert', row: r });
    queue.handle({ type: 'update', row: { ...r, title: 'renamed' } });
    expect(queue.getSnapshot()).toHaveLength(1);
    queue.handle({ type: 'update', row: { ...r, read_at: ago(0) } });
    expect(queue.getSnapshot()).toEqual([]);
    vi.advanceTimersByTime(ALARM_REPEAT_MS * 5);
    expect(chime).toHaveBeenCalledTimes(1);
  });

  it('a DELETE removes it', () => {
    const r = row();
    queue.handle({ type: 'insert', row: r });
    queue.handle({ type: 'delete', row: { id: r.id } });
    expect(queue.getSnapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('remove() drops it and its repeats', () => {
    const r = row();
    queue.handle({ type: 'insert', row: r });
    queue.remove(r.id);
    expect(queue.getSnapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('newest first, a stable array between changes', () => {
    const older = row({ created_at: ago(60_000) });
    const newer = row();
    queue.handle({ type: 'insert', row: newer });
    queue.handle({ type: 'insert', row: older });
    const snap = queue.getSnapshot();
    expect(snap.map((a) => a.id)).toEqual([newer.id, older.id]);
    vi.advanceTimersByTime(ALARM_REPEAT_MS);
    expect(queue.getSnapshot()).toBe(snap);
  });

  it('seed: fresh rows chime, older ones show silently as missed', () => {
    const fresh = row({ created_at: ago(ALARM_CHIME_FRESH_MS) });
    const stale = row({ created_at: ago(ALARM_CHIME_FRESH_MS + 1) });
    const tooOld = row({ created_at: ago(ALARM_MAX_AGE_MS + 1) });
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.seed([fresh, stale, tooOld], NOW);
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = queue.getSnapshot();
    expect(snap.map((a) => [a.id, a.missed])).toEqual([
      [fresh.id, false],
      [stale.id, true],
    ]);
    expect(chime.mock.calls).toEqual([[fresh.id, 0]]);
    vi.advanceTimersByTime(ALARM_REPEAT_MS * 5);
    expect(chime.mock.calls.every(([id]) => id === fresh.id)).toBe(true);
  });

  it('seed then the same row by realtime does not chime twice', () => {
    const r = row();
    queue.seed([r], NOW);
    queue.handle({ type: 'insert', row: r });
    expect(chime).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot()).toHaveLength(1);
  });

  it('busy: the card shows, nothing chimes, and skipped chimes do not count', () => {
    queue.setBusy(true);
    const r = row();
    queue.handle({ type: 'insert', row: r });
    expect(queue.getSnapshot()).toHaveLength(1);
    expect(chime).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ALARM_REPEAT_MS * 4);
    expect(chime).not.toHaveBeenCalled();

    queue.setBusy(false);
    vi.advanceTimersByTime(ALARM_REPEAT_MS);
    expect(chime).toHaveBeenLastCalledWith(r.id, 0);
    vi.advanceTimersByTime(ALARM_REPEAT_MS * 10);
    expect(chime).toHaveBeenCalledTimes(ALARM_MAX_CHIMES);
  });

  it('stops repeating once the row is two hours old, still showing it', () => {
    queue.setBusy(true);
    queue.handle({
      type: 'insert',
      row: row({ created_at: ago(ALARM_MAX_AGE_MS - 90_000) }),
    });
    vi.advanceTimersByTime(ALARM_REPEAT_MS * 3);
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.getSnapshot()).toHaveLength(1);
  });

  it('close() clears every timer and empties the stack', () => {
    queue.handle({ type: 'insert', row: row() });
    queue.handle({ type: 'insert', row: row() });
    expect(vi.getTimerCount()).toBe(2);
    queue.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.getSnapshot()).toEqual([]);
    vi.advanceTimersByTime(ALARM_REPEAT_MS * 5);
    expect(chime).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const off = queue.subscribe(listener);
    off();
    queue.handle({ type: 'insert', row: row() });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('visibleAlarms', () => {
  it('shows at most three and counts the rest', () => {
    const alarms = Array.from({ length: 5 }, () => alarmFor(row(), NOW)!);
    const { shown, hidden } = visibleAlarms(alarms);
    expect(shown).toHaveLength(ALARM_MAX_VISIBLE);
    expect(shown[0]).toBe(alarms[0]);
    expect(hidden).toBe(2);
    expect(visibleAlarms(alarms.slice(0, 2)).hidden).toBe(0);
  });
});

describe('snoozeUntil', () => {
  it('offers the three options', () => {
    expect(SNOOZE_OPTIONS).toEqual(['10m', '1h', 'tomorrow']);
  });

  it('10 minutes and an hour from now', () => {
    const now = new Date(2026, 10, 12, 14, 7, 30);
    expect(snoozeUntil('10m', now).getTime() - now.getTime()).toBe(600_000);
    expect(snoozeUntil('1h', now).getTime() - now.getTime()).toBe(3_600_000);
  });

  it("tomorrow is the next day at 09:00 in the account's zone", () => {
    const at = (now: string, zone?: string) =>
      snoozeUntil('tomorrow', new Date(now), zone).toISOString();
    // 23:50 on 30 November in Dubai, across a month end.
    expect(at('2026-11-30T19:50:00Z')).toBe('2026-12-01T05:00:00.000Z');
    // 00:05 on the 12th in Dubai, still the 11th in UTC.
    expect(at('2026-11-11T20:05:00Z')).toBe('2026-11-13T05:00:00.000Z');
    expect(at('2026-11-11T20:05:00Z', 'Asia/Seoul')).toBe(
      '2026-11-13T00:00:00.000Z'
    );
  });
});

describe('flashTitle', () => {
  it('alternates the page title and the alarm', () => {
    expect(flashTitle('Inbox', 'Call Ahmed', 0)).toBe('Inbox');
    expect(flashTitle('Inbox', 'Call Ahmed', 1)).toBe('⏰ Call Ahmed');
    expect(flashTitle('Inbox', 'Call Ahmed', 2)).toBe('Inbox');
  });
});

describe('AlarmQueue after a gap (wake)', () => {
  const chime = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    chime.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a missed alarm rings once, flagged missed, with its real time', () => {
    const queue = new AlarmQueue({ chime });
    const missed = row({ created_at: ago(90 * 60_000) });
    queue.seed([missed], NOW, { wake: true });
    expect(queue.getSnapshot()).toMatchObject([
      { id: missed.id, missed: true, createdAt: NOW - 90 * 60_000 },
    ]);
    vi.advanceTimersByTime(10 * ALARM_REPEAT_MS);
    expect(chime.mock.calls).toEqual([[missed.id, 0]]);
    queue.close();
  });

  it('one just due rings as usual, one over two hours old not at all', () => {
    const queue = new AlarmQueue({ chime });
    const fresh = row();
    const old = row({ created_at: ago(ALARM_MAX_AGE_MS + 1) });
    queue.seed([fresh, old], NOW, { wake: true });
    vi.advanceTimersByTime(5 * ALARM_REPEAT_MS);
    expect(queue.getSnapshot().map((a) => a.id)).toEqual([fresh.id]);
    expect(chime).toHaveBeenCalledTimes(ALARM_MAX_CHIMES);
    queue.close();
  });

  it('what is shown, dismissed or read elsewhere does not come back', () => {
    const queue = new AlarmQueue({ chime });
    const [shown, dismissed, read] = [row(), row(), row()];
    queue.seed([shown, dismissed], NOW);
    queue.remove(dismissed.id);
    queue.handle({
      type: 'update',
      row: { ...read, read_at: new Date(NOW).toISOString() },
    });
    chime.mockReset();
    queue.seed([shown, dismissed, read], NOW, { wake: true });
    expect(queue.getSnapshot().map((a) => a.id)).toEqual([shown.id]);
    expect(chime).not.toHaveBeenCalled();
    queue.close();
  });

  it('a missed alarm waits out a call before its one chime', () => {
    const queue = new AlarmQueue({ chime });
    queue.setBusy(true);
    queue.seed([row({ created_at: ago(30 * 60_000) })], NOW, { wake: true });
    expect(chime).not.toHaveBeenCalled();
    queue.setBusy(false);
    vi.advanceTimersByTime(3 * ALARM_REPEAT_MS);
    expect(chime).toHaveBeenCalledTimes(1);
    queue.close();
  });
});
