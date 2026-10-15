import { describe, expect, it } from 'vitest';

import { repeatValues, whenText } from './popover-format';

describe('whenText', () => {
  it('shows a timed item in the calendar zone', () => {
    const text = whenText(
      {
        start: '2026-10-15T06:00:00.000Z',
        end: '2026-10-15T07:00:00.000Z',
        allDay: false,
      },
      'Asia/Dubai',
      'en-GB'
    );
    expect(text).toContain('10:00');
    expect(text).toContain('11:00');
    expect(text).toContain('15');
  });

  it('shows a one-day all-day item as one date (end exclusive)', () => {
    const text = whenText(
      { start: '2026-10-15', end: '2026-10-16', allDay: true },
      'Asia/Dubai',
      'en-GB'
    );
    expect(text).toBe('Thu 15 Oct');
  });

  it('shows a multi-day all-day item with its last day inclusive', () => {
    const text = whenText(
      { start: '2026-10-15', end: '2026-10-18', allDay: true },
      'Asia/Dubai',
      'en-GB'
    );
    expect(text).toContain('17');
    expect(text).not.toContain('18');
  });

  it('shows a zero-length item (a task) as its moment alone', () => {
    const at = '2026-10-15T06:00:00.000Z';
    const text = whenText(
      { start: at, end: at, allDay: false },
      'Asia/Dubai',
      'en-GB'
    );
    expect(text).toContain('10:00');
    expect(text).not.toContain('–');
  });
});

describe('repeatValues', () => {
  it('names weekdays in the locale', () => {
    const v = repeatValues(
      { key: 'weekly', values: { interval: 2, weekdays: ['MO', 'WE'] } },
      'en-GB'
    );
    expect(v).toMatchObject({ interval: 2, days: 'Mon and Wed' });
  });

  it('gives the yearly date and the end values', () => {
    const v = repeatValues(
      {
        key: 'yearly',
        values: {
          interval: 1,
          month: 10,
          monthDay: 15,
          ends: 'on',
          until: '2027-01-31',
        },
      },
      'en-GB'
    );
    expect(v.date).toBe('15 October');
    expect(v.until).toBe('31 Jan 2027');
  });

  it('passes the nth weekday through', () => {
    const v = repeatValues(
      {
        key: 'monthlyNth',
        values: { interval: 1, nth: 3, weekday: 'TH', count: 5 },
      },
      'en-GB'
    );
    expect(v).toMatchObject({ nth: 3, weekday: 'Thursday', count: 5 });
  });
});
