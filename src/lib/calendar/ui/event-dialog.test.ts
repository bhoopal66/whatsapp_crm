import { describe, expect, it } from 'vitest';

import {
  attendeeCandidates,
  choiceDescription,
  formChanged,
  meetingStartOf,
  repeatChoiceOf,
  repeatChoices,
  repeatPreview,
  timeZoneChoices,
  withRepeatChoice,
} from './event-dialog';
import { formFromEvent, formFromSelection, type EventRow } from './event-form';

const DUBAI = 'Asia/Dubai';

// Thursday 15 Oct 2026, 10:00–11:00 Dubai: the 3rd Thursday, not the last.
const thu15 = () =>
  formFromSelection(
    new Date('2026-10-15T06:00:00Z'),
    new Date('2026-10-15T07:00:00Z'),
    false,
    DUBAI
  );
// Thursday 29 Oct 2026: the 5th, and the last, Thursday.
const thu29 = () =>
  formFromSelection(
    new Date('2026-10-29T06:00:00Z'),
    new Date('2026-10-29T07:00:00Z'),
    false,
    DUBAI
  );

describe('time zone choices', () => {
  it('puts the account zone first, adds the event zone, no duplicates', () => {
    const list = timeZoneChoices('Asia/Dubai', 'America/New_York');
    expect(list[0]).toBe('Asia/Dubai');
    expect(list[1]).toBe('America/New_York');
    expect(list).toContain('Asia/Seoul');
    expect(list).toContain('UTC');
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('repeat choices', () => {
  it('offers the nth weekday up to the 4th and the last only when it is', () => {
    expect(repeatChoices(thu15())).toEqual([
      'none',
      'daily',
      'weekly',
      'monthlyDate',
      'monthlyNth',
      'yearly',
    ]);
    expect(repeatChoices(thu29())).toEqual([
      'none',
      'daily',
      'weekly',
      'monthlyDate',
      'monthlyLast',
      'yearly',
    ]);
  });

  it('always offers the current choice', () => {
    const v = withRepeatChoice(thu15(), 'monthlyNth');
    const moved = { ...v, startDate: '2026-10-29' };
    expect(repeatChoices(moved)).toContain('monthlyNth');
    expect(repeatChoiceOf(moved)).toBe('monthlyNth');
  });

  it('shows a kept custom rule until another option is picked', () => {
    const row: EventRow = {
      id: 'e1',
      title: 'Odd',
      description: null,
      location: null,
      start_at: '2026-10-15T06:00:00.000Z',
      end_at: '2026-10-15T07:00:00.000Z',
      all_day: false,
      time_zone: DUBAI,
      color: 'blue',
      rrule: 'FREQ=DAILY;BYHOUR=9',
      visibility: 'attendees',
      reminders: null,
      created_by: 'me',
    };
    const v = formFromEvent(row, []);
    expect(repeatChoiceOf(v)).toBe('custom');
    expect(repeatChoices(v)).toContain('custom');
    expect(withRepeatChoice(v, 'custom')).toBe(v);
    const daily = withRepeatChoice(v, 'daily');
    expect(daily.customRrule).toBeNull();
    expect(repeatChoiceOf(daily)).toBe('daily');
    expect(repeatChoices(daily)).not.toContain('custom');
  });

  it('weekly starts on the start weekday', () => {
    const v = withRepeatChoice(
      { ...thu15(), repeat: { ...thu15().repeat, weekdays: [] } },
      'weekly'
    );
    expect(v.repeat).toMatchObject({ freq: 'weekly', weekdays: ['TH'] });
  });

  it('labels each option from the start date', () => {
    expect(choiceDescription(thu15(), 'monthlyDate')).toMatchObject({
      key: 'monthlyDate',
      values: { monthDay: 15, interval: 1 },
    });
    expect(choiceDescription(thu15(), 'monthlyNth')).toMatchObject({
      key: 'monthlyNth',
      values: { nth: 3, weekday: 'TH' },
    });
    expect(choiceDescription(thu15(), 'none')).toBeNull();
    expect(
      choiceDescription({ ...thu15(), startDate: '' }, 'daily')
    ).toBeNull();
  });
});

describe('repeat preview', () => {
  it('describes what would be saved', () => {
    expect(repeatPreview(thu15())).toBe('none');
    const v = withRepeatChoice(thu15(), 'daily');
    expect(
      repeatPreview({
        ...v,
        repeat: { ...v.repeat, interval: 2, ends: 'after', count: 3 },
      })
    ).toMatchObject({
      key: 'daily',
      values: { interval: 2, ends: 'after', count: 3 },
    });
  });

  it('is invalid when the picker state cannot be saved', () => {
    const last = withRepeatChoice(thu29(), 'monthlyLast');
    expect(repeatPreview({ ...last, startDate: '2026-10-15' })).toBe('invalid');
    const v = withRepeatChoice(thu15(), 'daily');
    expect(repeatPreview({ ...v, repeat: { ...v.repeat, interval: 0 } })).toBe(
      'invalid'
    );
  });
});

describe('unsaved changes', () => {
  it('compares against the opening values', () => {
    const a = thu15();
    expect(formChanged({ ...a }, a)).toBe(false);
    expect(formChanged({ ...a, title: 'x' }, a)).toBe(true);
  });
});

describe('attendee search', () => {
  const people = [
    { user_id: 'me', full_name: 'Me Myself', email: 'me@x.ae' },
    { user_id: 'a', full_name: 'Amal Hassan', email: 'amal@x.ae' },
    { user_id: 'b', full_name: 'Bilal', email: 'bilal@x.ae' },
    {
      user_id: 'c',
      full_name: 'Amira',
      email: 'amira@x.ae',
      deactivated_at: '2026-01-01',
    },
  ];

  it('matches name or email, skipping me, added and deactivated people', () => {
    expect(
      attendeeCandidates(people, 'am', [], ['me']).map((p) => p.user_id)
    ).toEqual(['a']);
    expect(attendeeCandidates(people, 'X.AE', ['a'], ['me'])).toEqual([
      people[2],
    ]);
    expect(attendeeCandidates(people, '  ', [], [])).toEqual([]);
  });
});

describe('video meeting instead', () => {
  it('starts at the form start, or 09:00 for an all-day day', () => {
    expect(meetingStartOf(thu15())?.toISOString()).toBe(
      '2026-10-15T06:00:00.000Z'
    );
    expect(meetingStartOf({ ...thu15(), allDay: true })?.toISOString()).toBe(
      '2026-10-15T05:00:00.000Z'
    );
    expect(meetingStartOf({ ...thu15(), startDate: '' })).toBeUndefined();
  });
});
