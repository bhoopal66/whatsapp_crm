import { describe, expect, it } from 'vitest';

import { chipDetails, chipLayout } from './event-chip';
import { aMeeting, aTask, anEvent } from './test-items';

const at = (hhmm: string) => Date.parse(`2026-10-15T${hhmm}:00Z`);

describe('chipLayout', () => {
  it('uses the agenda layout in every list view, all-day or not', () => {
    expect(chipLayout('listWeek', false, at('10:00'), at('11:00'))).toBe(
      'list'
    );
    expect(chipLayout('listWeek', true, null, null)).toBe('list');
  });

  it('draws all-day items as bars outside the agenda', () => {
    expect(chipLayout('timeGridWeek', true, null, null)).toBe('bar');
    expect(chipLayout('dayGridMonth', true, null, null)).toBe('bar');
  });

  it('draws timed items in month and year cells as rows', () => {
    expect(chipLayout('dayGridMonth', false, at('10:00'), at('11:00'))).toBe(
      'row'
    );
    expect(chipLayout('multiMonthYear', false, at('10:00'), at('11:00'))).toBe(
      'row'
    );
  });

  it('splits time-grid chips at 30 minutes', () => {
    expect(chipLayout('timeGridDay', false, at('10:00'), at('10:29'))).toBe(
      'compact'
    );
    expect(chipLayout('timeGridDay', false, at('10:00'), at('10:30'))).toBe(
      'full'
    );
    expect(chipLayout('timeGridWeek', false, at('10:00'), null)).toBe(
      'compact'
    );
  });
});

describe('chipDetails', () => {
  it('carries an event’s trimmed location, invitees and recurrence', () => {
    expect(
      chipDetails(
        anEvent({
          location: '  Board room ',
          attendeeCount: 3,
          recurring: true,
        })
      )
    ).toEqual({ location: 'Board room', attendees: 3, recurring: true });
  });

  it('treats a blank location as none', () => {
    expect(chipDetails(anEvent({ location: '   ' })).location).toBeNull();
  });

  it('gives meetings and tasks no details', () => {
    const none = { location: null, attendees: 0, recurring: false };
    expect(chipDetails(aMeeting())).toEqual(none);
    expect(chipDetails(aTask())).toEqual(none);
  });
});
