import { describe, expect, it } from 'vitest';

import {
  parseCalendarParams,
  parseDateKey,
  serialiseCalendarParams,
  viewKeyOf,
} from './url-state';

describe('parseCalendarParams', () => {
  it('reads date, view and event', () => {
    expect(
      parseCalendarParams(
        new URLSearchParams('date=2026-10-15&view=month&event=abc-123')
      )
    ).toEqual({ date: '2026-10-15', view: 'month', eventId: 'abc-123' });
  });

  it('reads a Next searchParams object', () => {
    expect(
      parseCalendarParams({ date: ['2026-02-01'], view: 'agenda' })
    ).toEqual({
      date: '2026-02-01',
      view: 'agenda',
      eventId: null,
    });
  });

  it('drops anything invalid', () => {
    expect(
      parseCalendarParams(
        new URLSearchParams('date=2026-02-30&view=decade&event=<x>')
      )
    ).toEqual({ date: null, view: 'week', eventId: null });
  });
});

describe('parseDateKey', () => {
  it('accepts only real dates', () => {
    expect(parseDateKey('2028-02-29')).toBe('2028-02-29');
    expect(parseDateKey('2026-02-29')).toBeNull();
    expect(parseDateKey('2026-1-1')).toBeNull();
    expect(parseDateKey(7)).toBeNull();
  });
});

describe('serialiseCalendarParams', () => {
  it('sets date and view, keeps other params, drops a handled event', () => {
    const qs = serialiseCalendarParams('foo=1&event=abc', {
      date: '2026-10-15',
      view: 'day',
      eventId: null,
    });
    expect(new URLSearchParams(qs).get('foo')).toBe('1');
    expect(new URLSearchParams(qs).get('date')).toBe('2026-10-15');
    expect(new URLSearchParams(qs).get('view')).toBe('day');
    expect(new URLSearchParams(qs).has('event')).toBe(false);
  });

  it('round-trips through the parser', () => {
    const state = { date: '2026-12-01', view: 'year' as const, eventId: 'e9' };
    expect(
      parseCalendarParams(
        new URLSearchParams(serialiseCalendarParams('', state))
      )
    ).toEqual(state);
  });
});

describe('viewKeyOf', () => {
  it('maps FullCalendar views back', () => {
    expect(viewKeyOf('timeGridWeek')).toBe('week');
    expect(viewKeyOf('multiMonthYear')).toBe('year');
    expect(viewKeyOf('listWeek')).toBe('agenda');
    expect(viewKeyOf('resourceTimeline')).toBeNull();
  });
});
