import { describe, expect, it } from 'vitest';

import {
  feedItemToEventInput,
  feedItemsToEventInputs,
  isItemEditable,
} from './event-input';
import { aMeeting, aTask, anEvent } from './test-items';

describe('feedItemToEventInput', () => {
  it('maps an event with its colour variables and key', () => {
    const input = feedItemToEventInput(anEvent());
    expect(input).toMatchObject({
      id: 'event:e1:2026-10-15T06:00:00.000Z',
      title: 'Planning',
      start: '2026-10-15T06:00:00.000Z',
      end: '2026-10-15T07:00:00.000Z',
      allDay: false,
      editable: true,
      backgroundColor: 'var(--cal-blue-soft)',
      borderColor: 'var(--cal-blue)',
    });
    expect(input?.classNames).toEqual(['cal-ev', 'cal-ev--event']);
    expect(input?.extendedProps).toEqual({ item: anEvent() });
  });

  it('keeps all-day dates as dates', () => {
    const input = feedItemToEventInput(aTask());
    expect(input).toMatchObject({
      start: '2026-10-16',
      end: '2026-10-17',
      allDay: true,
    });
  });

  it('dims a declined invitation and dashes a pending one', () => {
    expect(
      feedItemToEventInput(anEvent({ myResponse: 'declined' }))?.classNames
    ).toContain('cal-ev--declined');
    expect(
      feedItemToEventInput(anEvent({ myResponse: 'pending' }))?.classNames
    ).toContain('cal-ev--pending');
    expect(
      feedItemToEventInput(anEvent({ myResponse: 'accepted' }))?.classNames
    ).toEqual(['cal-ev', 'cal-ev--event']);
  });

  it('never makes a task editable, even when the server says so', () => {
    expect(isItemEditable(aTask({ editable: true }))).toBe(false);
    expect(feedItemToEventInput(aTask({ editable: true }))?.editable).toBe(
      false
    );
  });

  it('follows the server for events and meetings', () => {
    expect(feedItemToEventInput(anEvent({ editable: false }))?.editable).toBe(
      false
    );
    expect(feedItemToEventInput(aMeeting({ editable: true }))?.editable).toBe(
      true
    );
    expect(feedItemToEventInput(aMeeting({ editable: false }))?.editable).toBe(
      false
    );
  });

  it('leaves cancelled meetings off', () => {
    expect(feedItemToEventInput(aMeeting({ status: 'cancelled' }))).toBeNull();
    expect(
      feedItemsToEventInputs([
        aMeeting({ status: 'cancelled' }),
        aMeeting({ id: 'm2' }),
      ])
    ).toHaveLength(1);
  });

  it('falls back to slate for an unknown colour', () => {
    const bad = anEvent({ color: 'chartreuse' as never });
    expect(feedItemToEventInput(bad)?.borderColor).toBe('var(--cal-slate)');
  });
});
