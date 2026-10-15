import { describe, expect, it } from 'vitest';

import { expandEvent, rruleError } from './recurrence';
import {
  anchorFacts,
  defaultRepeatForm,
  describeRrule,
  formToRrule,
  rruleToForm,
  shiftRule,
  type RepeatAnchor,
  type RepeatForm,
} from './rrule-form';

// 30 Oct 2026 is a Friday, the month's last (and fifth).
const LAST_FRI: RepeatAnchor = { date: '2026-10-30', timeZone: 'Asia/Dubai' };
// 15 Oct 2026 is the third Thursday, not the last.
const THIRD_THU: RepeatAnchor = { date: '2026-10-15', timeZone: 'Asia/Dubai' };

const form = (
  anchor: RepeatAnchor,
  patch: Partial<RepeatForm>
): RepeatForm => ({
  ...defaultRepeatForm(anchor),
  ...patch,
});

describe('anchorFacts', () => {
  it('reads weekday, ordinal and last-ness from the date', () => {
    expect(anchorFacts(LAST_FRI)).toEqual({
      weekday: 'FR',
      monthDay: 30,
      month: 10,
      nth: 5,
      isLast: true,
    });
    expect(anchorFacts(THIRD_THU)).toMatchObject({
      weekday: 'TH',
      nth: 3,
      isLast: false,
    });
  });
});

describe('formToRrule / rruleToForm', () => {
  const cases: [string, RepeatAnchor, Partial<RepeatForm>, string | null][] = [
    ['none', THIRD_THU, { freq: 'none' }, null],
    ['daily', THIRD_THU, { freq: 'daily' }, 'FREQ=DAILY'],
    [
      'every 3 days',
      THIRD_THU,
      { freq: 'daily', interval: 3 },
      'FREQ=DAILY;INTERVAL=3',
    ],
    [
      'weekly on days',
      THIRD_THU,
      { freq: 'weekly', weekdays: ['MO', 'WE', 'FR'] },
      'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    ],
    [
      'fortnightly',
      THIRD_THU,
      { freq: 'weekly', interval: 2, weekdays: ['TH'] },
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH',
    ],
    [
      'monthly by date',
      THIRD_THU,
      { freq: 'monthly' },
      'FREQ=MONTHLY;BYMONTHDAY=15',
    ],
    [
      'monthly third Thursday',
      THIRD_THU,
      { freq: 'monthly', monthly: 'nth' },
      'FREQ=MONTHLY;BYDAY=3TH',
    ],
    [
      'monthly last Friday',
      LAST_FRI,
      { freq: 'monthly', monthly: 'last' },
      'FREQ=MONTHLY;BYDAY=-1FR',
    ],
    ['yearly', THIRD_THU, { freq: 'yearly' }, 'FREQ=YEARLY'],
    [
      'ends after 10',
      THIRD_THU,
      { freq: 'daily', ends: 'after', count: 10 },
      'FREQ=DAILY;COUNT=10',
    ],
    [
      'ends on a date (end of that day in Dubai, as UTC)',
      THIRD_THU,
      { freq: 'weekly', weekdays: ['TH'], ends: 'on', until: '2026-12-31' },
      'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231T195959Z',
    ],
  ];

  it.each(cases)('%s round-trips', (_, anchor, patch, body) => {
    const f = form(anchor, patch);
    expect(formToRrule(f, anchor)).toBe(body);
    expect(rruleToForm(body, anchor)).toEqual(f);
    if (body) expect(rruleError(body)).toBeNull();
  });

  it('expands "last Friday monthly" to the last Fridays', () => {
    const body = formToRrule(
      form(LAST_FRI, { freq: 'monthly', monthly: 'last' }),
      LAST_FRI
    );
    const { occurrences } = expandEvent(
      {
        start_at: '2026-10-30T05:00:00Z',
        end_at: '2026-10-30T06:00:00Z',
        all_day: false,
        time_zone: 'Asia/Dubai',
        rrule: body,
      },
      Date.parse('2026-10-01T00:00:00Z'),
      Date.parse('2027-01-01T00:00:00Z')
    );
    expect(occurrences.map((o) => new Date(o.start).toISOString())).toEqual([
      '2026-10-30T05:00:00.000Z',
      '2026-11-27T05:00:00.000Z',
      '2026-12-25T05:00:00.000Z',
    ]);
  });

  it('keeps the UNTIL day itself, even across a DST zone', () => {
    const anchor = { date: '2026-03-02', timeZone: 'Europe/London' };
    const body = formToRrule(
      form(anchor, { freq: 'daily', ends: 'on', until: '2026-04-01' }),
      anchor
    )!;
    expect(body).toBe('FREQ=DAILY;UNTIL=20260401T225959Z');
    const { occurrences } = expandEvent(
      {
        start_at: '2026-03-02T09:00:00Z',
        end_at: '2026-03-02T10:00:00Z',
        all_day: false,
        time_zone: 'Europe/London',
        rrule: body,
      },
      Date.parse('2026-03-01T00:00:00Z'),
      Date.parse('2026-05-01T00:00:00Z')
    );
    expect(new Date(occurrences.at(-1)!.start).toISOString()).toBe(
      '2026-04-01T08:00:00.000Z'
    );
  });

  it('reads a date-only UNTIL and a weekly rule without BYDAY', () => {
    expect(rruleToForm('FREQ=WEEKLY;UNTIL=20261231', THIRD_THU)).toEqual(
      form(THIRD_THU, {
        freq: 'weekly',
        weekdays: ['TH'],
        ends: 'on',
        until: '2026-12-31',
      })
    );
  });

  it('answers null for rules the picker cannot show', () => {
    for (const body of [
      'FREQ=MONTHLY;BYDAY=-1FR', // the anchor is a Thursday
      'FREQ=MONTHLY;BYDAY=2TH', // the anchor is the third
      'FREQ=MONTHLY;BYMONTHDAY=1',
      'FREQ=WEEKLY;BYDAY=1MO',
      'FREQ=DAILY;BYSETPOS=1',
      'FREQ=DAILY;WKST=SU',
      'FREQ=YEARLY;BYMONTH=2',
      'FREQ=DAILY;INTERVAL=100',
      'FREQ=DAILY;COUNT=1000',
      'FREQ=HOURLY',
    ]) {
      expect(rruleToForm(body, THIRD_THU)).toBeNull();
    }
  });

  it('refuses picker states it should not allow', () => {
    expect(() =>
      formToRrule(
        form(THIRD_THU, { freq: 'monthly', monthly: 'last' }),
        THIRD_THU
      )
    ).toThrow(/last/);
    expect(() =>
      formToRrule(form(THIRD_THU, { freq: 'daily', interval: 0 }), THIRD_THU)
    ).toThrow();
    expect(() =>
      formToRrule(
        form(THIRD_THU, { freq: 'daily', ends: 'after', count: 1000 }),
        THIRD_THU
      )
    ).toThrow();
    expect(() =>
      formToRrule(
        form(THIRD_THU, { freq: 'daily', ends: 'on', until: '2026-10-14' }),
        THIRD_THU
      )
    ).toThrow();
  });
});

describe('describeRrule', () => {
  it('returns a key and values for the UI to translate', () => {
    expect(describeRrule(null, THIRD_THU)).toBeNull();
    expect(describeRrule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=6', LAST_FRI)).toEqual({
      key: 'monthlyLast',
      values: { interval: 1, ends: 'after', count: 6, weekday: 'FR' },
    });
    expect(describeRrule('FREQ=MONTHLY;BYDAY=3TH', THIRD_THU)).toEqual({
      key: 'monthlyNth',
      values: { interval: 1, ends: 'never', weekday: 'TH', nth: 3 },
    });
    expect(
      describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,MO', THIRD_THU)
    ).toEqual({
      key: 'weekly',
      values: { interval: 2, ends: 'never', weekdays: ['MO', 'TU'] },
    });
    expect(
      describeRrule('FREQ=YEARLY;UNTIL=20301015T195959Z', THIRD_THU)
    ).toEqual({
      key: 'yearly',
      values: {
        interval: 1,
        ends: 'on',
        until: '2030-10-15',
        month: 10,
        monthDay: 15,
      },
    });
    expect(describeRrule('FREQ=DAILY;BYSETPOS=1', THIRD_THU)).toEqual({
      key: 'custom',
      values: {},
    });
  });
});

describe('shiftRule', () => {
  // 5 Oct 2026 is a Monday; 13 Oct the 2nd Tuesday; 15 Oct the 15th.
  const MON: RepeatAnchor = { date: '2026-10-05', timeZone: 'Asia/Dubai' };
  const TUE2: RepeatAnchor = { date: '2026-10-13', timeZone: 'Asia/Dubai' };
  it('moves weekly days', () => {
    expect(shiftRule('FREQ=WEEKLY;BYDAY=MO', 1, MON)).toBe(
      'FREQ=WEEKLY;BYDAY=TU'
    );
    expect(shiftRule('FREQ=WEEKLY;BYDAY=MO,WE', 1, MON)).toBe(
      'FREQ=WEEKLY;BYDAY=TU,TH'
    );
    expect(shiftRule('FREQ=WEEKLY;BYDAY=MO,SU', -1, MON)).toBe(
      'FREQ=WEEKLY;BYDAY=SA,SU'
    );
  });
  it('moves a monthly date and nth / last weekday', () => {
    expect(shiftRule('FREQ=MONTHLY;BYMONTHDAY=15', 1, THIRD_THU)).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=16'
    );
    expect(shiftRule('FREQ=MONTHLY;BYDAY=2TU', 1, TUE2)).toBe(
      'FREQ=MONTHLY;BYDAY=2WE'
    );
    expect(shiftRule('FREQ=MONTHLY;BYDAY=-1FR', 1, LAST_FRI)).toBe(
      'FREQ=MONTHLY;BYDAY=-1SA'
    );
  });
  it('moves UNTIL with the series and keeps time-only moves', () => {
    expect(
      shiftRule('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261031T195959Z', 2, MON)
    ).toBe('FREQ=WEEKLY;BYDAY=WE;UNTIL=20261102T195959Z');
    expect(shiftRule('FREQ=WEEKLY;BYDAY=MO', 0, MON)).toBe(
      'FREQ=WEEKLY;BYDAY=MO'
    );
    expect(shiftRule('FREQ=DAILY;COUNT=5', 3, MON)).toBe('FREQ=DAILY;COUNT=5');
  });
  it('refuses what it cannot say exactly', () => {
    // 2nd TU on the 13th + 2 = 15th: the 3rd Thursday.
    expect(shiftRule('FREQ=MONTHLY;BYDAY=2TU', 2, TUE2)).toBeNull();
    // Last FR on the 30th + 2 = 1 Nov.
    expect(shiftRule('FREQ=MONTHLY;BYDAY=-1FR', 2, LAST_FRI)).toBeNull();
    expect(shiftRule('FREQ=MONTHLY;BYMONTHDAY=28', 1, MON)).toBeNull();
    expect(shiftRule('FREQ=MONTHLY;BYMONTHDAY=1', -1, MON)).toBeNull();
    // Every other week, SU + 1 lands in the next week, MO does not.
    expect(shiftRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU', 1, MON)).toBeNull();
    expect(shiftRule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1', 1, MON)).toBeNull();
    expect(shiftRule('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', 1, MON)).toBeNull();
  });
});
