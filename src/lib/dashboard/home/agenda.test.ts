import { describe, expect, it } from 'vitest';

import type {
  EventFeedItem,
  FeedItem,
  MeetingFeedItem,
  TaskFeedItem,
} from '@/lib/calendar/feed';
import { agendaFor, agendaRange, JOIN_LEAD_MS } from './agenda';

// Dubai is UTC+4 all year, so wall times convert by hand.
const ZONE = 'Asia/Dubai';
const at = (day: number, h: number, mi = 0) =>
  Date.UTC(2026, 9, day, h - 4, mi);
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at(28, 12); // Wed 28 Oct 2026, 12:00 Dubai

function event(
  title: string,
  start: number,
  end: number,
  over: Partial<EventFeedItem> = {}
): EventFeedItem {
  return {
    kind: 'event',
    id: `e-${title}`,
    occurrenceStart: iso(start),
    title,
    start: iso(start),
    end: iso(end),
    allDay: false,
    color: 'blue',
    editable: true,
    location: null,
    recurring: false,
    myResponse: 'organizer',
    organizerId: 'u',
    attendeeCount: 0,
    ...over,
  };
}

function meeting(
  id: string,
  start: number,
  end: number,
  status = 'scheduled'
): MeetingFeedItem {
  return {
    kind: 'meeting',
    id,
    occurrenceStart: iso(start),
    title: `Meeting ${id}`,
    start: iso(start),
    end: iso(end),
    allDay: false,
    color: 'violet',
    editable: false,
    status,
  };
}

const taskItem: TaskFeedItem = {
  kind: 'task',
  id: 't1',
  occurrenceStart: iso(at(28, 15)),
  title: 'Call back',
  start: iso(at(28, 15)),
  end: iso(at(28, 15)),
  allDay: false,
  color: 'amber',
  editable: false,
  contactId: null,
};

const titles = (items: { item: { title: string } }[]) =>
  items.map((e) => e.item.title);

describe('agendaRange', () => {
  it('runs from midnight today in the zone for seven days', () => {
    expect(agendaRange(NOW, ZONE)).toEqual({
      fromIso: iso(at(28, 0)),
      toIso: iso(at(35, 0)),
    });
  });
});

describe('agendaFor', () => {
  it('leaves tasks and declined invitations out', () => {
    const a = agendaFor(
      [
        taskItem,
        event('Declined', at(28, 14), at(28, 15), { myResponse: 'declined' }),
        event('Kept', at(28, 14), at(28, 15)),
      ],
      NOW,
      ZONE
    );
    expect(titles(a.today)).toEqual(['Kept']);
  });

  it("splits today from later days on the zone's midnight", () => {
    const items: FeedItem[] = [
      event('Tomorrow', at(29, 0), at(29, 1)),
      event('Late', at(28, 23, 30), at(29, 0, 30)),
      event('Morning', at(28, 9), at(28, 10)),
    ];
    const a = agendaFor(items, NOW, ZONE);
    expect(titles(a.today)).toEqual(['Morning', 'Late']);
    expect(a.next?.item.title).toBe('Tomorrow');
  });

  it('marks past, in-progress and upcoming items', () => {
    const a = agendaFor(
      [
        event('Past', at(28, 9), at(28, 10)),
        event('Now', at(28, 11, 30), at(28, 12, 30)),
        event('Ends now', at(28, 11), at(28, 12)),
        event('Soon', at(28, 13), at(28, 14)),
      ],
      NOW,
      ZONE
    );
    const state = Object.fromEntries(
      a.today.map((e) => [e.item.title, e.state])
    );
    expect(state).toEqual({
      Past: 'past',
      'Ends now': 'past',
      Now: 'now',
      Soon: 'upcoming',
    });
    expect(a.leftToday).toBe(2);
  });

  it('places an all-day item first and keeps it current all day', () => {
    const a = agendaFor(
      [
        event('Standup', at(28, 9), at(28, 9, 15)),
        event('Holiday', 0, 0, {
          allDay: true,
          start: '2026-10-28',
          end: '2026-10-29',
        }),
      ],
      NOW,
      ZONE
    );
    expect(titles(a.today)).toEqual(['Holiday', 'Standup']);
    expect(a.today[0].state).toBe('now');
  });

  it('opens Join from ten minutes before a meeting until its end', () => {
    const start = at(28, 12, 10);
    const open = agendaFor([meeting('m1', start, at(28, 13))], NOW, ZONE);
    expect(open.today[0].joinMeetingId).toBe('m1');
    const early = agendaFor(
      [meeting('m2', NOW + JOIN_LEAD_MS + 60_000, at(28, 13))],
      NOW,
      ZONE
    );
    expect(early.today[0].joinMeetingId).toBeNull();
    const over = agendaFor([meeting('m3', at(28, 11), at(28, 12))], NOW, ZONE);
    expect(over.today[0].joinMeetingId).toBeNull();
  });

  it('never offers Join on an ended meeting, and reads it as past', () => {
    const a = agendaFor(
      [meeting('m4', at(28, 11, 30), at(28, 12, 30), 'ended')],
      NOW,
      ZONE
    );
    expect(a.today[0].state).toBe('past');
    expect(a.today[0].joinMeetingId).toBeNull();
    expect(a.leftToday).toBe(0);
  });

  it('gives the next item when nothing is left today', () => {
    const a = agendaFor(
      [
        event('Done', at(28, 8), at(28, 9)),
        event('Friday', at(30, 10), at(30, 11)),
        event('Thursday', at(29, 15), at(29, 16)),
      ],
      NOW,
      ZONE
    );
    expect(a.leftToday).toBe(0);
    expect(a.next?.item.title).toBe('Thursday');
    expect(a.empty).toBe(false);
  });

  it('is empty with nothing today or later', () => {
    const a = agendaFor([taskItem], NOW, ZONE);
    expect(a).toEqual({ today: [], leftToday: 0, next: null, empty: true });
  });
});
