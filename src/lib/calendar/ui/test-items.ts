import type {
  EventFeedItem,
  FeedItem,
  MeetingFeedItem,
  TaskFeedItem,
} from '../feed';

/** Test fixtures for the calendar UI helpers. */
export function anEvent(over: Partial<EventFeedItem> = {}): EventFeedItem {
  return {
    kind: 'event',
    id: 'e1',
    occurrenceStart: '2026-10-15T06:00:00.000Z',
    title: 'Planning',
    start: '2026-10-15T06:00:00.000Z',
    end: '2026-10-15T07:00:00.000Z',
    allDay: false,
    color: 'blue',
    editable: true,
    location: null,
    recurring: false,
    myResponse: 'organizer',
    organizerId: 'u1',
    attendeeCount: 0,
    ...over,
  };
}

export function aMeeting(over: Partial<MeetingFeedItem> = {}): MeetingFeedItem {
  return {
    kind: 'meeting',
    id: 'm1',
    occurrenceStart: '2026-10-15T08:00:00.000Z',
    title: 'Standup',
    start: '2026-10-15T08:00:00.000Z',
    end: '2026-10-15T08:30:00.000Z',
    allDay: false,
    color: 'teal',
    editable: true,
    status: 'scheduled',
    ...over,
  };
}

export function aTask(over: Partial<TaskFeedItem> = {}): TaskFeedItem {
  return {
    kind: 'task',
    id: 't1',
    occurrenceStart: '2026-10-16',
    title: 'Call back',
    start: '2026-10-16',
    end: '2026-10-17',
    allDay: true,
    color: 'amber',
    editable: true,
    contactId: null,
    ...over,
  };
}

export type { FeedItem };
