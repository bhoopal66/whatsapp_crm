import { describe, expect, it } from 'vitest';

import {
  createBody,
  dateKeyInZone,
  defaultEventForm,
  editBody,
  formFromEvent,
  formFromSelection,
  withAllDay,
  withStart,
  type EventRow,
} from './event-form';

const DUBAI = 'Asia/Dubai';

const row = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'e1',
  title: 'Planning',
  description: null,
  location: null,
  start_at: '2026-10-15T06:00:00.000Z',
  end_at: '2026-10-15T07:00:00.000Z',
  all_day: false,
  time_zone: DUBAI,
  color: 'blue',
  rrule: null,
  visibility: 'attendees',
  reminders: [10],
  created_by: 'me',
  ...over,
});

describe('the repeat days and the start', () => {
  // Opened on Tuesday 24 November 2026.
  const opened = () => ({
    ...defaultEventForm(new Date('2026-11-24T05:10:00Z'), DUBAI),
    title: 'Weekly sync',
  });
  const weekly = (v: ReturnType<typeof opened>) => ({
    ...v,
    repeat: { ...v.repeat, freq: 'weekly' as const },
  });
  const saved = (v: ReturnType<typeof opened>) => {
    const r = createBody(v);
    return r.ok ? r.body.rrule : r.errors;
  };

  it('a weekly event is on the weekday of the date it was moved to', () => {
    const thursday = withStart(opened(), '2026-11-26', '10:00');
    expect(saved(weekly(thursday))).toBe('FREQ=WEEKLY;BYDAY=TH');
    // Weekly picked first, the date moved after.
    expect(saved(withStart(weekly(opened()), '2026-11-26', '10:00'))).toBe(
      'FREQ=WEEKLY;BYDAY=TH'
    );
  });

  it('follows through a half-typed date', () => {
    const typing = withStart(weekly(opened()), '', '10:00');
    const typed = withStart(typing, '2026-11-26', '10:00');
    expect(saved({ ...typed, endDate: '2026-11-26', endTime: '11:00' })).toBe(
      'FREQ=WEEKLY;BYDAY=TH'
    );
  });

  it('a monthly event is on the day of the date it was moved to', () => {
    const v = withStart(opened(), '2026-11-26', '10:00');
    expect(
      saved({ ...v, repeat: { ...v.repeat, freq: 'monthly' as const } })
    ).toBe('FREQ=MONTHLY;BYMONTHDAY=26');
  });

  it('chosen days stay, and a first date outside them is refused', () => {
    const v = weekly(opened());
    const chosen = { ...v, repeat: { ...v.repeat, weekdays: ['TU', 'WE'] } };
    const at = (date: string) =>
      saved(withStart(chosen as typeof v, date, '10:00'));
    expect(at('2026-11-25')).toBe('FREQ=WEEKLY;BYDAY=TU,WE');
    expect(at('2026-11-26')).toEqual({ repeat: 'repeatMissesStart' });
  });

  it('an event saved on the wrong day keeps its other fields editable', () => {
    // Thursday 15 October, repeating on Tuesdays.
    const original = formFromEvent(row({ rrule: 'FREQ=WEEKLY;BYDAY=TU' }), []);
    const edit = (v: typeof original) =>
      editBody(v, { original, scope: 'all' as const });
    expect(edit({ ...original, title: 'New' })).toEqual({
      ok: true,
      body: { title: 'New', scope: 'all' },
    });
    expect(edit(withStart(original, '2026-10-16', '10:00'))).toEqual({
      ok: false,
      errors: { repeat: 'repeatMissesStart' },
    });
    expect(
      edit({ ...original, repeat: { ...original.repeat, weekdays: ['TH'] } })
    ).toMatchObject({ ok: true, body: { rrule: 'FREQ=WEEKLY;BYDAY=TH' } });
  });
});

describe('dateKeyInZone', () => {
  it('reads the date in the zone, not in UTC', () => {
    // 20:00 UTC on the 14th is midnight on the 15th in Dubai.
    expect(dateKeyInZone(Date.parse('2026-10-14T20:00:00Z'), DUBAI)).toBe(
      '2026-10-15'
    );
  });
});

describe('formFromSelection', () => {
  it('turns an all-day selection into inclusive dates in the zone', () => {
    const v = formFromSelection(
      new Date('2026-10-14T20:00:00Z'), // 15 Oct 00:00 Dubai
      new Date('2026-10-16T20:00:00Z'), // 17 Oct 00:00 Dubai (exclusive)
      true,
      DUBAI
    );
    expect(v).toMatchObject({
      allDay: true,
      startDate: '2026-10-15',
      endDate: '2026-10-16',
    });
    const r = createBody({ ...v, title: 'Off' });
    expect(r.ok && r.body).toMatchObject({
      start: '2026-10-15',
      end: '2026-10-17',
      allDay: true,
      timeZone: DUBAI,
    });
  });

  it('keeps a timed selection as wall-clock times in the zone', () => {
    const v = formFromSelection(
      new Date('2026-10-15T05:00:00Z'),
      new Date('2026-10-15T06:30:00Z'),
      false,
      DUBAI
    );
    expect(v).toMatchObject({
      startDate: '2026-10-15',
      startTime: '09:00',
      endTime: '10:30',
    });
    const r = createBody({ ...v, title: 'x' });
    expect(r.ok && r.body).toMatchObject({
      start: '2026-10-15T05:00:00.000Z',
      end: '2026-10-15T06:30:00.000Z',
      allDay: false,
    });
  });
});

describe('createBody', () => {
  const v = () => ({
    ...defaultEventForm(new Date('2026-10-15T05:10:00Z'), DUBAI),
    title: '  Review  ',
  });

  it('builds the POST body', () => {
    const r = createBody(v());
    expect(r.ok && r.body).toMatchObject({
      title: 'Review',
      description: null,
      start: '2026-10-15T05:30:00.000Z',
      end: '2026-10-15T06:30:00.000Z',
      rrule: null,
      reminders: [10],
      attendees: [],
    });
  });

  it('reports inline errors', () => {
    const r = createBody({ ...v(), title: ' ', endTime: '08:00' });
    expect(r).toEqual({
      ok: false,
      errors: { title: 'titleRequired', end: 'endBeforeStart' },
    });
    const allDay = createBody({
      ...withAllDay(v(), true),
      endDate: '2026-10-14',
    });
    expect(allDay.ok || allDay.errors.end).toBe('endBeforeStart');
  });

  it('writes the repeat picker as a rule anchored on the start date', () => {
    const base = v();
    const r = createBody({
      ...base,
      repeat: { ...base.repeat, freq: 'weekly', weekdays: ['TH'] },
    });
    expect(r.ok && r.body.rrule).toMatch(/^FREQ=WEEKLY/);
  });
});

describe('formFromEvent', () => {
  it('shows an all-day end inclusive, in the event zone', () => {
    const v = formFromEvent(
      row({
        all_day: true,
        start_at: '2026-10-14T20:00:00.000Z',
        end_at: '2026-10-15T20:00:00.000Z',
      }),
      []
    );
    expect(v).toMatchObject({
      startDate: '2026-10-15',
      endDate: '2026-10-15',
    });
  });

  it('keeps a rule the picker cannot show, and drops me from attendees', () => {
    const v = formFromEvent(
      row({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=9' }),
      ['me', 'u2']
    );
    expect(v.customRrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=9');
    expect(v.attendees).toEqual(['u2']);
  });
});

describe('editBody', () => {
  it('sends only what changed, time fields together', () => {
    const original = formFromEvent(row(), []);
    expect(editBody(original, { original, scope: 'all' })).toEqual({
      ok: true,
      body: {},
    });
    const moved = withStart(original, '2026-10-16', '10:00');
    expect(moved.endTime).toBe('11:00');
    const r = editBody({ ...moved, title: 'New' }, { original, scope: 'all' });
    expect(r.ok && r.body).toEqual({
      title: 'New',
      start: '2026-10-16T06:00:00.000Z',
      end: '2026-10-16T07:00:00.000Z',
      allDay: false,
      timeZone: DUBAI,
      scope: 'all',
    });
  });

  it('edits one occurrence without its rule', () => {
    const original = formFromEvent(row({ rrule: 'FREQ=DAILY' }), [], {
      start: '2026-10-17T06:00:00.000Z',
      end: '2026-10-17T07:00:00.000Z',
    });
    const r = editBody(
      { ...original, location: 'Room 2' },
      {
        original,
        scope: 'this',
        occurrenceStart: '2026-10-17T06:00:00.000Z',
      }
    );
    expect(r.ok && r.body).toEqual({
      location: 'Room 2',
      scope: 'this',
      occurrenceStart: '2026-10-17T06:00:00.000Z',
    });
  });
});

describe('all-day reminders', () => {
  const NOW = new Date('2026-10-14T08:00:00Z');

  it('default to 09:00 the day before for an all-day selection', () => {
    const day = formFromSelection(
      new Date('2026-10-14T20:00:00Z'),
      new Date('2026-10-15T20:00:00Z'),
      true,
      DUBAI
    );
    expect(day.reminders).toEqual([900]);
    expect(defaultEventForm(NOW, DUBAI).reminders).toEqual([10]);
  });

  it('follow the all-day switch only while untouched', () => {
    const timed = defaultEventForm(NOW, DUBAI);
    const allDay = withAllDay(timed, true);
    expect(allDay.reminders).toEqual([900]);
    expect(withAllDay(allDay, false).reminders).toEqual([10]);

    const touched = { ...timed, reminders: [10, 60] };
    expect(withAllDay(touched, true).reminders).toEqual([10, 60]);
    const none = { ...timed, reminders: [] };
    expect(withAllDay(none, true).reminders).toEqual([]);
  });

  it('keeps a saved event’s reminders', () => {
    const saved = formFromEvent(
      row({
        all_day: true,
        start_at: '2026-10-14T20:00:00.000Z',
        end_at: '2026-10-15T20:00:00.000Z',
        reminders: [10],
      }),
      []
    );
    expect(saved.reminders).toEqual([10]);
    const off = withAllDay(saved, false, true);
    expect(off.reminders).toEqual([10]);
    expect(withAllDay(off, true, true).reminders).toEqual([10]);
  });
});
