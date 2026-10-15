import { describe, expect, it } from 'vitest';

import {
  MAX_INSTANCES,
  expandEvent,
  fromFloating,
  isOccurrence,
  rruleError,
  toFloating,
  wallClock,
} from './recurrence';

const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);
const weekly = (start: string, end: string, tz: string, extra = '') => ({
  start_at: start,
  end_at: end,
  all_day: false,
  time_zone: tz,
  rrule: `FREQ=WEEKLY${extra}`,
  exdates: [] as string[],
});

describe('zone helpers', () => {
  it('round-trips a wall clock through the zone', () => {
    const t = at('2026-07-01T08:00:00Z');
    expect(wallClock(t, 'Europe/London')).toMatchObject({ h: 9, d: 1, mo: 7 });
    expect(fromFloating(toFloating(t, 'Europe/London'), 'Europe/London')).toBe(
      t
    );
  });
});

describe('expandEvent', () => {
  it('keeps a weekly 09:00 Europe/London at 09:00 across both DST changes', () => {
    // 2026-03-29 (BST starts) and 2026-10-25 (BST ends) are Sundays.
    const ev = weekly(
      '2026-03-23T09:00:00Z',
      '2026-03-23T10:00:00Z',
      'Europe/London'
    );
    const { occurrences } = expandEvent(
      ev,
      at('2026-03-01T00:00:00Z'),
      at('2026-04-10T00:00:00Z')
    );
    expect(occurrences.map((o) => iso(o.start))).toEqual([
      '2026-03-23T09:00:00.000Z',
      '2026-03-30T08:00:00.000Z',
      '2026-04-06T08:00:00.000Z',
    ]);
    expect(occurrences[1].end - occurrences[1].start).toBe(3_600_000);
    const autumn = expandEvent(
      ev,
      at('2026-10-15T00:00:00Z'),
      at('2026-11-03T00:00:00Z')
    );
    expect(autumn.occurrences.map((o) => iso(o.start))).toEqual([
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
    ]);
  });

  it('keeps a weekly 09:00 Asia/Dubai at 05:00 UTC through March and October', () => {
    const ev = weekly(
      '2026-03-23T05:00:00Z',
      '2026-03-23T06:00:00Z',
      'Asia/Dubai'
    );
    const spring = expandEvent(
      ev,
      at('2026-03-23T00:00:00Z'),
      at('2026-04-07T00:00:00Z')
    );
    expect(spring.occurrences.map((o) => iso(o.start))).toEqual([
      '2026-03-23T05:00:00.000Z',
      '2026-03-30T05:00:00.000Z',
      '2026-04-06T05:00:00.000Z',
    ]);
    const autumn = expandEvent(
      ev,
      at('2026-10-19T00:00:00Z'),
      at('2026-10-27T00:00:00Z')
    );
    expect(autumn.occurrences.map((o) => iso(o.start))).toEqual([
      '2026-10-19T05:00:00.000Z',
      '2026-10-26T05:00:00.000Z',
    ]);
  });

  it('skips exdates and clips to the range, including one already under way', () => {
    const ev = {
      ...weekly('2026-01-05T09:00:00Z', '2026-01-05T11:00:00Z', 'UTC'),
      exdates: ['2026-01-12T09:00:00Z'],
    };
    const { occurrences } = expandEvent(
      ev,
      at('2026-01-05T10:00:00Z'),
      at('2026-01-19T09:00:00Z')
    );
    expect(occurrences.map((o) => iso(o.start))).toEqual([
      '2026-01-05T09:00:00.000Z',
    ]);
  });

  it('honours COUNT and UNTIL (an instant, read in the zone)', () => {
    const ev = weekly(
      '2026-01-05T09:00:00Z',
      '2026-01-05T10:00:00Z',
      'UTC',
      ';COUNT=2'
    );
    expect(
      expandEvent(ev, 0, at('2027-01-01T00:00:00Z')).occurrences
    ).toHaveLength(2);
    const until = weekly(
      '2026-01-05T09:00:00Z',
      '2026-01-05T10:00:00Z',
      'UTC',
      ';UNTIL=20260112T090000Z'
    );
    expect(
      expandEvent(until, 0, at('2027-01-01T00:00:00Z')).occurrences
    ).toHaveLength(2);
  });

  it(`caps a long range at ${MAX_INSTANCES} instances`, () => {
    const ev = {
      ...weekly('2020-01-01T09:00:00Z', '2020-01-01T10:00:00Z', 'UTC'),
      rrule: 'FREQ=DAILY',
    };
    const out = expandEvent(
      ev,
      at('2020-01-01T00:00:00Z'),
      at('2030-01-01T00:00:00Z')
    );
    expect(out.occurrences).toHaveLength(MAX_INSTANCES);
    expect(out.truncated).toBe(true);
  });

  it('gives a one-day all-day event stored with end = start a whole day', () => {
    const ev = {
      start_at: '2026-03-29T00:00:00Z',
      end_at: '2026-03-29T00:00:00Z',
      all_day: true,
      time_zone: 'Europe/London',
      rrule: null,
    };
    const [o] = expandEvent(
      ev,
      at('2026-03-28T00:00:00Z'),
      at('2026-03-31T00:00:00Z')
    ).occurrences;
    expect(iso(o.end)).toBe('2026-03-29T23:00:00.000Z'); // 23-hour day
  });

  it('knows which starts are occurrences', () => {
    const ev = weekly(
      '2026-03-23T09:00:00Z',
      '2026-03-23T10:00:00Z',
      'Europe/London'
    );
    expect(isOccurrence(ev, at('2026-03-30T08:00:00Z'))).toBe(true);
    expect(isOccurrence(ev, at('2026-03-30T09:00:00Z'))).toBe(false);
  });
});

describe('rruleError', () => {
  it('accepts the shapes the form builds', () => {
    for (const r of [
      'FREQ=DAILY;INTERVAL=2',
      'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=YEARLY;UNTIL=20301231T235959Z',
    ]) {
      expect(rruleError(r)).toBeNull();
    }
  });

  it('refuses what it will not expand', () => {
    for (const r of [
      'RRULE:FREQ=DAILY',
      'FREQ=HOURLY',
      'FREQ=DAILY;BYHOUR=9',
      'FREQ=DAILY;COUNT=2;UNTIL=20300101',
      'FREQ=DAILY;DTSTART=20260101T000000Z',
      'FREQ=DAILY; COUNT=2',
      'FREQ=DAILY;' + 'INTERVAL=1;'.repeat(50),
    ]) {
      expect(rruleError(r)).not.toBeNull();
    }
  });
});
