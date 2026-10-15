import { describe, expect, it } from 'vitest';

import { parseEventInput } from './validate';

const ME = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

const base = {
  title: '  Standup  ',
  start: '2026-10-20T09:00:00+04:00',
  end: '2026-10-20T09:30:00+04:00',
  allDay: false,
  timeZone: 'Asia/Dubai',
  color: 'teal',
  visibility: 'attendees',
  reminders: [10],
};

const ok = (raw: unknown, opts = {}) => {
  const r = parseEventInput(raw, { creatorId: ME, ...opts });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const err = (raw: unknown, opts = {}) => {
  const r = parseEventInput(raw, { creatorId: ME, ...opts });
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
};

describe('parseEventInput: create', () => {
  it('trims, converts a timed event to instants and defaults the rest', () => {
    expect(ok({ ...base, description: '  ', location: ' Room 2 ' })).toEqual({
      title: 'Standup',
      description: null,
      location: 'Room 2',
      start_at: '2026-10-20T05:00:00.000Z',
      end_at: '2026-10-20T05:30:00.000Z',
      all_day: false,
      time_zone: 'Asia/Dubai',
      color: 'teal',
      visibility: 'attendees',
      reminders: [10],
      rrule: null,
      attendees: [],
    });
  });

  it('turns all-day dates into midnight in the event zone, end exclusive', () => {
    const v = ok({
      ...base,
      allDay: true,
      start: '2026-03-28',
      end: '2026-03-30',
      timeZone: 'Europe/London',
    });
    expect(v.start_at).toBe('2026-03-28T00:00:00.000Z');
    // 29 March 2026 is the clocks-forward day: midnight on the 30th is BST.
    expect(v.end_at).toBe('2026-03-29T23:00:00.000Z');
    expect(v.all_day).toBe(true);
  });

  it('requires the core fields', () => {
    expect(err({ ...base, title: '   ' })).toMatch(/title/);
    expect(err({ ...base, color: undefined })).toMatch(/colour/);
    expect(err({ ...base, reminders: undefined })).toMatch(/reminders/);
    expect(err({ ...base, timeZone: undefined })).toMatch(/together/);
  });

  it('rejects bad times, zones, colours and visibility', () => {
    expect(err({ ...base, start: '2026-10-20T09:00:00' })).toMatch(/offset/);
    expect(err({ ...base, end: base.start })).toMatch(/end after/);
    expect(err({ ...base, timeZone: 'Mars/Olympus' })).toMatch(/time zone/);
    expect(
      err({ ...base, allDay: true, start: '2026-02-30', end: '2026-03-02' })
    ).toMatch(/real date/);
    expect(
      err({ ...base, allDay: true, start: '2026-10-20', end: '2026-10-20' })
    ).toMatch(/end after/);
    expect(err({ ...base, color: 'orange' })).toMatch(/colour/);
    expect(err({ ...base, visibility: 'public' })).toMatch(/visibility/);
    expect(err('nope')).toMatch(/object/);
  });

  it('enforces the text limits', () => {
    expect(err({ ...base, title: 'x'.repeat(201) })).toMatch(/200/);
    expect(err({ ...base, location: 'x'.repeat(301) })).toMatch(/300/);
    expect(err({ ...base, description: 'x'.repeat(5001) })).toMatch(/5000/);
    expect(
      ok({ ...base, description: 'x'.repeat(5000) }).description
    ).toHaveLength(5000);
  });

  it('sorts and de-duplicates reminders within the limits', () => {
    expect(ok({ ...base, reminders: [60, 0, 60, 40320] }).reminders).toEqual([
      0, 60, 40320,
    ]);
    expect(err({ ...base, reminders: [40321] })).toMatch(/40320/);
    expect(err({ ...base, reminders: [1.5] })).toMatch(/whole/);
    expect(err({ ...base, reminders: [1, 2, 3, 4, 5, 6] })).toMatch(
      /At most 5/
    );
  });

  it('checks the repeat rule', () => {
    expect(ok({ ...base, rrule: ' FREQ=WEEKLY;BYDAY=MO ' }).rrule).toBe(
      'FREQ=WEEKLY;BYDAY=MO'
    );
    expect(ok({ ...base, rrule: '' }).rrule).toBeNull();
    expect(err({ ...base, rrule: 'FREQ=HOURLY' })).toMatch(/daily, weekly/);
    expect(
      err({ ...base, rrule: 'FREQ=DAILY;COUNT=2;UNTIL=20270101' })
    ).toMatch(/not both/);
  });

  it('de-duplicates attendees, drops the organiser and caps the list', () => {
    expect(
      ok({ ...base, attendees: [A, A.toUpperCase(), ME, B] }).attendees
    ).toEqual([A, B]);
    expect(err({ ...base, attendees: ['bob'] })).toMatch(/person id/);
    const many = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    expect(err({ ...base, attendees: many })).toMatch(/100/);
    expect(
      ok({ ...base, attendees: many.slice(0, 100) }).attendees
    ).toHaveLength(100);
  });
});

describe('parseEventInput: patch', () => {
  const patch = { partial: true };

  it('returns only the keys present', () => {
    expect(ok({ title: ' New ', color: 'red' }, patch)).toEqual({
      title: 'New',
      color: 'red',
    });
    expect(ok({ rrule: null }, patch)).toEqual({ rrule: null });
    expect(ok({ description: null }, patch)).toEqual({ description: null });
  });

  it('moves the time block only as a whole', () => {
    expect(err({ start: base.start }, patch)).toMatch(/together/);
    const v = ok(
      {
        start: base.start,
        end: base.end,
        allDay: false,
        timeZone: 'Asia/Dubai',
      },
      patch
    );
    expect(v.start_at).toBe('2026-10-20T05:00:00.000Z');
  });

  it('needs the occurrence when changing just one', () => {
    expect(err({ scope: 'this', title: 'x' }, patch)).toMatch(
      /occurrenceStart/
    );
    expect(
      ok({ scope: 'this', occurrenceStart: '2026-10-20T09:00:00+04:00' }, patch)
    ).toEqual({ scope: 'this', occurrenceStart: '2026-10-20T05:00:00.000Z' });
    expect(ok({ scope: 'all' }, patch)).toEqual({ scope: 'all' });
    expect(err({ scope: 'future' }, patch)).toMatch(/scope/);
  });
});

describe('parseEventInput: date range and rule sanity', () => {
  it('refuses years outside 1970..2100, timed and all-day', () => {
    expect(err({ ...base, start: '0001-01-01T09:00:00+04:00' })).toMatch(
      /start must be between 1970 and 2100/
    );
    expect(err({ ...base, end: '2101-01-01T09:30:00+04:00' })).toMatch(
      /end must be between 1970 and 2100/
    );
    expect(
      err({ ...base, allDay: true, start: '1969-12-31', end: '1970-01-01' })
    ).toMatch(/start must be between/);
    expect(
      ok({ ...base, allDay: true, start: '2100-12-30', end: '2100-12-31' })
        .all_day
    ).toBe(true);
  });

  it('refuses a rule that never produces a date', () => {
    expect(
      err({ ...base, rrule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30' })
    ).toMatch(/no date within 10 years/);
    expect(ok({ ...base, rrule: 'FREQ=WEEKLY;BYDAY=TU' }).rrule).toBe(
      'FREQ=WEEKLY;BYDAY=TU'
    );
  });

  it('leaves a rule-only patch to the caller', () => {
    expect(
      ok({ rrule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30' }, { partial: true })
        .rrule
    ).toBe('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30');
  });
});
