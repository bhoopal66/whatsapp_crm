import { describe, expect, it } from 'vitest';

import { eventDragBody, meetingDragBody, shiftSeries } from './drag';
import { descriptionParts, popoverActions } from './popover-rules';
import {
  parseCustomReminder,
  reminderLabel,
  toggleReminder,
} from './reminder-chips';
import { aMeeting, anEvent, aTask } from './test-items';

const detail = (createdBy: string, canEdit: boolean) => ({
  createdBy,
  canEdit,
  attendees: [
    { user_id: 'u2', response: 'pending' as const },
    { user_id: 'u3', response: 'accepted' as const },
  ],
});

describe('popoverActions', () => {
  it('offers Edit and Delete to the organiser only', () => {
    const a = popoverActions(anEvent(), detail('u1', true), 'u1');
    expect(a).toMatchObject({ edit: true, remove: true, rsvp: false });
    const b = popoverActions(anEvent(), detail('u1', false), 'u2');
    expect(b).toMatchObject({ edit: false, remove: false, rsvp: true });
    // Never on the client's say-so alone.
    expect(popoverActions(anEvent(), detail('u1', true), 'u2').edit).toBe(
      false
    );
  });

  it('lets an invitee answer, and set reminders once answered', () => {
    expect(popoverActions(anEvent(), detail('u1', false), 'u2')).toMatchObject({
      rsvp: true,
      myResponse: 'pending',
      notify: false,
    });
    expect(popoverActions(anEvent(), detail('u1', false), 'u3')).toMatchObject({
      rsvp: true,
      myResponse: 'accepted',
      notify: true,
    });
    expect(popoverActions(anEvent(), detail('u1', false), 'u9').rsvp).toBe(
      false
    );
  });

  it('asks for a scope on a recurring event', () => {
    const a = popoverActions(
      anEvent({ recurring: true }),
      detail('u1', true),
      'u1'
    );
    expect(a.askScope).toBe(true);
  });

  it('offers Join on a live meeting and the contact on a task', () => {
    expect(popoverActions(aMeeting(), null, 'u1')).toMatchObject({
      join: true,
      edit: false,
    });
    expect(popoverActions(aMeeting({ status: 'ended' }), null, 'u1').join).toBe(
      false
    );
    expect(
      popoverActions(aTask({ contactId: 'c1' }), null, 'u1').contactId
    ).toBe('c1');
  });
});

describe('descriptionParts', () => {
  it('links http(s) only', () => {
    expect(
      descriptionParts('see https://a.example/x. or javascript:alert(1)')
    ).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'link',
        text: 'https://a.example/x',
        href: 'https://a.example/x',
      },
      { type: 'text', text: '. or javascript:alert(1)' },
    ]);
  });
});

describe('reminder chips', () => {
  it('toggles, sorted, at most five', () => {
    expect(toggleReminder([10], 5)).toEqual([5, 10]);
    expect(toggleReminder([5, 10], 5)).toEqual([10]);
    expect(toggleReminder([0, 5, 10, 15, 30], 60)).toEqual([0, 5, 10, 15, 30]);
  });

  it('parses custom minutes', () => {
    expect(parseCustomReminder('90')).toBe(90);
    expect(parseCustomReminder(' 2h ')).toBe(120);
    expect(parseCustomReminder('1d')).toBe(1440);
    expect(parseCustomReminder('29d')).toBeNull();
    expect(parseCustomReminder('-5')).toBeNull();
    expect(parseCustomReminder('abc')).toBeNull();
  });

  it('labels', () => {
    expect(reminderLabel(0).key).toBe('atStart');
    expect(reminderLabel(120)).toEqual({ key: 'hours', count: 2 });
    expect(reminderLabel(2880)).toEqual({ key: 'days', count: 2 });
    expect(reminderLabel(45)).toEqual({ key: 'minutes', count: 45 });
  });
});

describe('drag bodies', () => {
  const series = {
    start_at: '2026-10-01T06:00:00.000Z',
    end_at: '2026-10-01T07:00:00.000Z',
    all_day: false,
    time_zone: 'Europe/London',
  };

  it('moves a one-off event, keeping its zone and flag', () => {
    expect(
      eventDragBody(
        anEvent(),
        { ...series, time_zone: 'Asia/Dubai' },
        new Date('2026-10-15T08:00:00Z'),
        null,
        'all',
        'Asia/Dubai'
      )
    ).toEqual({
      start: '2026-10-15T08:00:00.000Z',
      end: '2026-10-15T09:00:00.000Z',
      allDay: false,
      timeZone: 'Asia/Dubai',
    });
  });

  it('moves one occurrence with scope this', () => {
    const item = anEvent({ recurring: true });
    expect(
      eventDragBody(
        item,
        series,
        new Date('2026-10-15T07:00:00Z'),
        new Date('2026-10-15T08:00:00Z'),
        'this',
        'Asia/Dubai'
      )
    ).toMatchObject({ scope: 'this', occurrenceStart: item.occurrenceStart });
  });

  it('shifts a series by wall-clock time across a DST change', () => {
    // London: 1 Oct is BST (UTC+1); 30 Oct is GMT.
    const item = anEvent({
      recurring: true,
      start: '2026-10-29T10:00:00.000Z', // 10:00 GMT
      end: '2026-10-29T11:00:00.000Z',
    });
    const out = shiftSeries(
      item,
      { start: '2026-10-29T11:00:00.000Z', end: '2026-10-29T12:00:00.000Z' },
      {
        ...series,
        start_at: '2026-10-01T09:00:00.000Z',
        end_at: '2026-10-01T10:00:00.000Z',
      }
    );
    // 10:00 BST → 11:00 BST.
    expect(out).toEqual({
      start: '2026-10-01T10:00:00.000Z',
      end: '2026-10-01T11:00:00.000Z',
    });
  });

  it('shifts an all-day series by whole days, read in its zone', () => {
    const item = anEvent({
      recurring: true,
      allDay: true,
      start: '2026-10-15',
      end: '2026-10-16',
    });
    expect(
      shiftSeries(
        item,
        { start: '2026-10-17', end: '2026-10-18' },
        {
          start_at: '2026-09-30T20:00:00.000Z', // 1 Oct, Dubai
          end_at: '2026-10-01T20:00:00.000Z',
          all_day: true,
          time_zone: 'Asia/Dubai',
        }
      )
    ).toEqual({ start: '2026-10-03', end: '2026-10-04' });
  });

  it('saves a dragged all-day event as dates in the calendar zone', () => {
    const item = anEvent({
      allDay: true,
      start: '2026-10-15',
      end: '2026-10-16',
    });
    expect(
      eventDragBody(
        item,
        { ...series, all_day: true, time_zone: 'Asia/Dubai' },
        new Date('2026-10-16T20:00:00Z'), // 17 Oct 00:00 Dubai
        null,
        'all',
        'Asia/Dubai'
      )
    ).toMatchObject({ start: '2026-10-17', end: '2026-10-18', allDay: true });
  });

  it('keeps a meeting length when only moved', () => {
    expect(
      meetingDragBody(aMeeting(), new Date('2026-10-20T10:00:00Z'), null)
    ).toEqual({
      scheduledStart: '2026-10-20T10:00:00.000Z',
      scheduledEnd: new Date(
        Date.parse('2026-10-20T10:00:00Z') +
          (Date.parse(aMeeting().end) - Date.parse(aMeeting().start))
      ).toISOString(),
    });
  });
});
