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
