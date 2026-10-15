import { describe, expect, it } from 'vitest';

import {
  MAX_INSTANCES,
  expandEvent,
  fromFloating,
  isOccurrence,
  rruleError,
  rruleSanity,
  seriesEndAt,
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

describe('bounded walk', () => {
  const FEB30 = 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30';
  const ev = (rrule: string, start = '2026-01-05T05:00:00Z') => ({
    start_at: start,
    end_at: iso(at(start) + 30 * 60_000),
    all_day: false,
    time_zone: 'Asia/Dubai',
    rrule,
    exdates: [] as string[],
  });

  it('expands a rule that never matches quickly and empty', () => {
    const t = performance.now();
    const out = expandEvent(
      ev(FEB30),
      at('2026-10-01T00:00:00Z'),
      at('2026-11-01T00:00:00Z')
    );
    expect(performance.now() - t).toBeLessThan(200);
    expect(out).toEqual({ occurrences: [], truncated: false });
  }, 2000);

  it('stops looking once the matches run out past the window', () => {
    // Matches end in 2027 (UNTIL), the window is 2026: no walk to 9999.
    const t = performance.now();
    const out = expandEvent(
      ev(
        'FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29',
        '2025-01-01T05:00:00Z'
      ),
      at('2026-01-01T00:00:00Z'),
      at('2026-12-31T00:00:00Z')
    );
    expect(performance.now() - t).toBeLessThan(200);
    expect(out.occurrences).toEqual([]);
  }, 2000);

  it('still finds every date of a long-running series in a late window', () => {
    const out = expandEvent(
      ev('FREQ=DAILY', '1970-01-05T05:00:00Z'),
      at('2026-10-01T00:00:00Z'),
      at('2026-10-08T00:00:00Z')
    );
    expect(out.occurrences.map((o) => iso(o.start))).toEqual([
      '2026-10-01T05:00:00.000Z',
      '2026-10-02T05:00:00.000Z',
      '2026-10-03T05:00:00.000Z',
      '2026-10-04T05:00:00.000Z',
      '2026-10-05T05:00:00.000Z',
      '2026-10-06T05:00:00.000Z',
      '2026-10-07T05:00:00.000Z',
    ]);
  });

  it('finds a sparse monthly date late in a window', () => {
    // 31st of each month: the window's only one is 31 Dec.
    const out = expandEvent(
      ev('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31T05:00:00Z'),
      at('2026-12-01T00:00:00Z'),
      at('2027-01-01T00:00:00Z')
    );
    expect(out.occurrences.map((o) => iso(o.start))).toEqual([
      '2026-12-31T05:00:00.000Z',
    ]);
  });
});

describe('rruleSanity', () => {
  const anchor = {
    start_at: '2026-01-05T05:00:00Z',
    end_at: '2026-01-05T05:30:00Z',
    all_day: false,
    time_zone: 'Asia/Dubai',
  };
  it('refuses a rule with no date within 10 years, quickly', () => {
    const t = performance.now();
    expect(rruleSanity('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', anchor)).toMatch(
      /no date within 10 years/
    );
    expect(rruleSanity('FREQ=DAILY;UNTIL=20250101', anchor)).toMatch(
      /no date within/
    );
    expect(performance.now() - t).toBeLessThan(200);
  }, 2000);
  it('passes ordinary rules and reports syntax errors first', () => {
    expect(rruleSanity('FREQ=WEEKLY;BYDAY=MO,WE', anchor)).toBeNull();
    expect(
      rruleSanity('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', anchor)
    ).toBeNull();
    expect(rruleSanity('FREQ=HOURLY', anchor)).toBe(rruleError('FREQ=HOURLY'));
  });
});

describe('seriesEndAt', () => {
  const base = {
    start_at: '2026-10-01T05:00:00Z', // 09:00 Dubai
    end_at: '2026-10-01T05:30:00Z',
    all_day: false,
    time_zone: 'Asia/Dubai',
    exdates: [] as string[],
  };
  it('is null for an open-ended series or a one-off', () => {
    expect(seriesEndAt({ ...base, rrule: 'FREQ=DAILY' })).toBeNull();
    expect(seriesEndAt({ ...base, rrule: null })).toBeNull();
  });
  it('ends with the last occurrence of a COUNT rule', () => {
    expect(
      seriesEndAt({ ...base, rrule: 'FREQ=DAILY;COUNT=3' })?.toISOString()
    ).toBe('2026-10-03T05:30:00.000Z');
  });
  it('ends with the last occurrence on or before UNTIL, exdates ignored', () => {
    expect(
      seriesEndAt({
        ...base,
        rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261028',
        exdates: ['2026-10-22T05:00:00Z'],
      })?.toISOString()
    ).toBe('2026-10-22T05:30:00.000Z');
  });
  it('is null when a COUNT runs past the horizon', () => {
    expect(seriesEndAt({ ...base, rrule: 'FREQ=YEARLY;COUNT=500' })).toBeNull();
  });
});
