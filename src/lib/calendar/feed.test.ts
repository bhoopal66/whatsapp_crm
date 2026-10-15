import { describe, expect, it } from 'vitest';

import {
  buildFeed,
  type BuildFeedInput,
  type EventFeedItem,
  type FeedEventRow,
} from './feed';

const ME = 'me';
const OTHER = 'other';
const at = (s: string) => Date.parse(s);

const event = (patch: Partial<FeedEventRow>): FeedEventRow => ({
  id: 'e1',
  created_by: ME,
  title: 'Standup',
  location: null,
  start_at: '2026-10-19T05:00:00Z',
  end_at: '2026-10-19T05:30:00Z',
  all_day: false,
  time_zone: 'Asia/Dubai',
  color: 'blue',
  rrule: null,
  exdates: [],
  status: 'confirmed',
  ...patch,
});

const feed = (patch: Partial<BuildFeedInput>) =>
  buildFeed({
    events: [],
    attendeeRows: [],
    meetings: [],
    tasks: [],
    me: ME,
    fromMs: at('2026-10-19T00:00:00Z'),
    toMs: at('2026-10-26T00:00:00Z'),
    ...patch,
  });

describe('buildFeed', () => {
  it('expands a series, skipping exdates and cancelled events', () => {
    const items = feed({
      events: [
        event({
          rrule: 'FREQ=DAILY',
          exdates: ['2026-10-20T05:00:00Z'],
        }),
        event({ id: 'gone', status: 'cancelled' }),
      ],
    });
    expect(items.map((i) => i.occurrenceStart)).toEqual([
      '2026-10-19T05:00:00.000Z',
      '2026-10-21T05:00:00.000Z',
      '2026-10-22T05:00:00.000Z',
      '2026-10-23T05:00:00.000Z',
      '2026-10-24T05:00:00.000Z',
      '2026-10-25T05:00:00.000Z',
    ]);
    expect(items[0]).toEqual({
      kind: 'event',
      id: 'e1',
      occurrenceStart: '2026-10-19T05:00:00.000Z',
      title: 'Standup',
      start: '2026-10-19T05:00:00.000Z',
      end: '2026-10-19T05:30:00.000Z',
      allDay: false,
      color: 'blue',
      editable: true,
      location: null,
      recurring: true,
      myResponse: 'organizer',
      organizerId: ME,
      attendeeCount: 0,
    });
  });

  it('gives an invitee their response, never edit rights, and keeps a decline', () => {
    const rows = [
      { event_id: 'e1', user_id: ME, response: 'declined' as const },
      { event_id: 'e1', user_id: 'x', response: 'accepted' as const },
      { event_id: 'e2', user_id: 'y', response: 'pending' as const },
    ];
    const items = feed({
      events: [
        event({ created_by: OTHER }),
        event({
          id: 'e2',
          created_by: OTHER,
          start_at: '2026-10-20T05:00:00Z',
          end_at: '2026-10-20T06:00:00Z',
        }),
      ],
      attendeeRows: rows,
    }) as EventFeedItem[];
    expect(
      items.map((i) => [i.id, i.editable, i.myResponse, i.attendeeCount])
    ).toEqual([
      ['e1', false, 'declined', 2],
      ['e2', false, null, 1],
    ]);
  });

  it('dates an all-day event in its own zone, end exclusive', () => {
    // 20 Oct in Dubai: midnight there is 20:00 UTC the day before.
    const [item] = feed({
      events: [
        event({
          all_day: true,
          start_at: '2026-10-19T20:00:00Z',
          end_at: '2026-10-19T20:00:00Z',
        }),
      ],
    });
    expect(item).toMatchObject({
      allDay: true,
      start: '2026-10-20',
      end: '2026-10-21',
    });
    expect(item.occurrenceStart).toBe('2026-10-19T20:00:00.000Z');
  });

  it('adds meetings and tasks in range, and sorts everything by start', () => {
    const items = feed({
      events: [
        event({
          start_at: '2026-10-20T09:00:00Z',
          end_at: '2026-10-20T10:00:00Z',
        }),
      ],
      meetings: [
        {
          id: 'm1',
          title: 'Review',
          scheduled_start: '2026-10-20T08:00:00Z',
          scheduled_end: null,
          host_user_id: OTHER,
          status: 'scheduled',
        },
        {
          id: 'm2',
          title: 'Mine',
          scheduled_start: '2026-10-21T08:00:00Z',
          scheduled_end: '2026-10-21T09:00:00Z',
          host_user_id: ME,
          status: 'scheduled',
        },
        {
          id: 'old',
          title: 'Old',
          scheduled_start: '2026-10-01T08:00:00Z',
          scheduled_end: null,
          host_user_id: ME,
          status: 'ended',
        },
        {
          id: 'adhoc',
          title: 'Ad hoc',
          scheduled_start: null,
          scheduled_end: null,
          host_user_id: ME,
          status: 'live',
        },
      ],
      tasks: [
        {
          id: 't1',
          title: 'Call back',
          due_at: '2026-10-19T12:00:00Z',
          contact_id: 'c1',
        },
        {
          id: 't2',
          title: 'Later',
          due_at: '2026-10-26T00:00:00Z',
          contact_id: null,
        },
        { id: 't3', title: 'Undated', due_at: null, contact_id: null },
      ],
    });
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'task:t1',
      'meeting:m1',
      'event:e1',
      'meeting:m2',
    ]);
    expect(items[0]).toEqual({
      kind: 'task',
      id: 't1',
      occurrenceStart: '2026-10-19T12:00:00.000Z',
      title: 'Call back',
      start: '2026-10-19T12:00:00.000Z',
      end: '2026-10-19T12:00:00.000Z',
      allDay: false,
      color: 'amber',
      editable: false,
      contactId: 'c1',
    });
    expect(items[1]).toMatchObject({
      kind: 'meeting',
      end: '2026-10-20T08:30:00.000Z',
      color: 'violet',
      editable: false,
      status: 'scheduled',
    });
    expect(items[3]).toMatchObject({ editable: true });
  });

  it('drops duplicates of the same instance', () => {
    const items = feed({ events: [event({}), event({})] });
    expect(items).toHaveLength(1);
  });
});
