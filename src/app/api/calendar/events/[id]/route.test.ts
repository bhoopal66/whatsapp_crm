import { beforeEach, describe, expect, it, vi } from 'vitest';

// One event: read it, change it (the row, or one occurrence of a series
// moved out into a standalone copy), delete it (the row, or one
// occurrence). The fake database holds every row as an admin's client
// would; `rls` stands in for the creator-only UPDATE/DELETE policies and
// `after` for someone else writing between our read and our write.

import { fakeSupabase, type FakeDb } from '../../test-db';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { DELETE, GET, PATCH } from './route';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ONE = '33333333-3333-4333-8333-333333333333';
const SERIES = '44444444-4444-4444-8444-444444444444';
const T1 = '2026-10-01T08:00:00.000Z';
const T2 = '2026-10-01T08:05:00.000Z';
// Mondays 09:00 Dubai (UTC+4): 05:00Z.
const OCC = '2026-10-12T05:00:00.000Z';
const EXCLUDED = '2026-10-19T05:00:00.000Z';

let db: FakeDb;

function eventRow(over: Record<string, unknown>) {
  return {
    account_id: 'acct-1',
    created_by: ME,
    title: 'Sync',
    description: null,
    location: 'Room 1',
    all_day: false,
    time_zone: 'Asia/Dubai',
    color: 'blue',
    visibility: 'attendees',
    reminders: [10],
    rrule: null,
    exdates: [],
    status: 'confirmed',
    created_at: T1,
    updated_at: T1,
    ...over,
  };
}

const ctx = (userId: string) => ({
  role: 'agent',
  userId,
  accountId: 'acct-1',
  supabase: fakeSupabase(db),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = ONE) => GET(new Request('http://x'), params(id));
const patch = (body: unknown, id = ONE) =>
  PATCH(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
    params(id)
  );
const del = (id = ONE, query = '') =>
  DELETE(new Request(`http://x/?${query}`, { method: 'DELETE' }), params(id));

const events = () => db.tables.calendar_events;
const find = (id: string) => events().find((r) => r.id === id)!;
const attendeesOf = (id: string) =>
  db.tables.calendar_event_attendees
    .filter((r) => r.event_id === id)
    .map((r) => [r.user_id, r.response]);

/** The organiser-only policies: the creator, and only them. */
const creatorOnly = (userId: string) => ({
  'calendar_events:update': (r: Record<string, unknown>) =>
    r.created_by === userId,
  'calendar_events:delete': (r: Record<string, unknown>) =>
    r.created_by === userId,
});

/** Someone else saves the series right after our first read of it. */
function concurrentEditAfterRead(id: string) {
  let done = false;
  db.after = {
    'calendar_events:select': () => {
      if (done) return;
      done = true;
      const rows = events();
      const i = rows.findIndex((r) => r.id === id);
      rows[i] = { ...rows[i], updated_at: T2 };
    },
  };
}

describe('/api/calendar/events/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = {
      tables: {
        calendar_events: [
          eventRow({
            id: ONE,
            start_at: '2026-10-10T05:00:00.000Z',
            end_at: '2026-10-10T06:00:00.000Z',
          }),
          eventRow({
            id: SERIES,
            title: 'Standup',
            start_at: '2026-10-05T05:00:00.000Z',
            end_at: '2026-10-05T05:30:00.000Z',
            rrule: 'FREQ=WEEKLY',
            exdates: [EXCLUDED],
          }),
        ],
        calendar_event_attendees: [
          {
            event_id: ONE,
            user_id: U1,
            response: 'accepted',
            responded_at: T1,
          },
          { event_id: SERIES, user_id: U1, response: 'accepted' },
          { event_id: SERIES, user_id: U2, response: 'declined' },
        ],
      },
    };
    mocks.getCurrentAccount.mockResolvedValue(ctx(ME));
  });

  describe('GET', () => {
    it('returns the event, its attendees and whether the caller may edit', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.event).toMatchObject({ id: ONE, title: 'Sync' });
      // (The fake does not project columns; the route selects three.)
      expect(body.attendees).toEqual([
        expect.objectContaining({
          user_id: U1,
          response: 'accepted',
          responded_at: T1,
        }),
      ]);
      expect(body.canEdit).toBe(true);

      mocks.getCurrentAccount.mockResolvedValue(ctx(OTHER));
      expect((await (await get()).json()).canEdit).toBe(false);
    });

    it('answers 404 for an event the caller cannot see, 400 for a bad id', async () => {
      expect((await get('55555555-5555-4555-8555-555555555555')).status).toBe(
        404
      );
      expect((await get('nope')).status).toBe(400);
    });
  });

  describe('PATCH a one-off event or a whole series', () => {
    it('updates the row and turns the attendee list into the new one', async () => {
      const res = await patch({ title: ' Review ', attendees: [U2] });
      expect(res.status).toBe(200);
      expect((await res.json()).event).toMatchObject({
        id: ONE,
        title: ' Review '.trim(),
      });
      expect(find(ONE).title).toBe('Review');
      expect(attendeesOf(ONE)).toEqual([[U2, 'pending']]);
      // The series' attendees are untouched.
      expect(attendeesOf(SERIES)).toHaveLength(2);
    });

    it('changes only the attendees when nothing else is sent', async () => {
      const res = await patch({ attendees: [U1, U2] });
      expect(res.status).toBe(200);
      expect(attendeesOf(ONE)).toEqual([
        [U1, 'accepted'],
        [U2, 'pending'],
      ]);
    });

    it('moves the exdates with the series by the same wall-clock delta', async () => {
      const winter = '2026-11-02T05:00:00.000Z';
      find(SERIES).exdates = [EXCLUDED, winter];
      // 09:00 Dubai → 09:00 London (BST until 25 October, GMT after).
      const res = await patch(
        {
          start: '2026-10-05T08:00:00Z',
          end: '2026-10-05T08:30:00Z',
          allDay: false,
          timeZone: 'Europe/London',
          scope: 'all',
        },
        SERIES
      );
      expect(res.status).toBe(200);
      expect(find(SERIES)).toMatchObject({
        start_at: '2026-10-05T08:00:00.000Z',
        time_zone: 'Europe/London',
        exdates: ['2026-10-19T08:00:00.000Z', '2026-11-02T09:00:00.000Z'],
      });
    });

    it('leaves the exdates alone when the series keeps its start', async () => {
      const res = await patch({ title: 'Daily', scope: 'all' }, SERIES);
      expect(res.status).toBe(200);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('answers 409 when the series was saved in between', async () => {
      concurrentEditAfterRead(SERIES);
      const res = await patch(
        {
          start: '2026-10-05T06:00:00Z',
          end: '2026-10-05T06:30:00Z',
          allDay: false,
          timeZone: 'Asia/Dubai',
        },
        SERIES
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This event was changed by someone else; reload',
      });
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
      expect(find(SERIES).start_at).toBe('2026-10-05T05:00:00.000Z');
    });

    it('refuses someone who is not the organiser, writing nothing', async () => {
      db.rls = creatorOnly(OTHER);
      mocks.getCurrentAccount.mockResolvedValue(ctx(OTHER));
      const res = await patch({ title: 'Mine now', attendees: [] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Only the organiser can change this event',
      });
      expect(find(ONE).title).toBe('Sync');
      expect(attendeesOf(ONE)).toHaveLength(1);
    });

    it('answers 403 when the policy refuses the write (0 rows)', async () => {
      db.rls = { 'calendar_events:update': () => false };
      const res = await patch({ title: 'Blocked', attendees: [U2] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Only the organiser can change this event',
      });
      expect(find(ONE).title).toBe('Sync');
      expect(attendeesOf(ONE)).toEqual([[U1, 'accepted']]);
    });

    it('maps a refused write (42501) to the organiser message', async () => {
      db.errors = { 'calendar_events:update': { code: '42501' } };
      const res = await patch({ title: 'Blocked' });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(
        'Only the organiser can change this event'
      );
    });

    it('refuses an empty or invalid patch before reading', async () => {
      expect((await patch({})).status).toBe(400);
      expect((await patch({ start: '2026-10-10T05:00:00Z' })).status).toBe(400);
      expect((await patch({ title: 'x' }, 'nope')).status).toBe(400);
    });
  });

  describe('PATCH one occurrence of a series', () => {
    const moveOne = (over: Record<string, unknown> = {}) =>
      patch(
        {
          title: 'Standup (moved)',
          scope: 'this',
          occurrenceStart: OCC,
          ...over,
        },
        SERIES
      );

    it('makes a standalone copy with the change, then excludes the occurrence', async () => {
      const res = await moveOne();
      expect(res.status).toBe(200);
      const { event } = await res.json();
      expect(event).toMatchObject({
        title: 'Standup (moved)',
        created_by: ME,
        account_id: 'acct-1',
        start_at: OCC,
        end_at: '2026-10-12T05:30:00.000Z',
        rrule: null,
        exdates: [],
        location: 'Room 1',
      });
      expect(event.id).not.toBe(SERIES);
      expect(attendeesOf(event.id)).toEqual([
        [U1, 'pending'],
        [U2, 'pending'],
      ]);
      expect(find(SERIES).exdates).toEqual([EXCLUDED, OCC]);
      expect(find(SERIES).title).toBe('Standup');
    });

    it('takes new times and attendees for the copy when sent', async () => {
      const res = await moveOne({
        start: '2026-10-13T10:00:00Z',
        end: '2026-10-13T11:00:00Z',
        allDay: false,
        timeZone: 'Asia/Dubai',
        attendees: [U2],
      });
      expect(res.status).toBe(200);
      const { event } = await res.json();
      expect(event).toMatchObject({
        start_at: '2026-10-13T10:00:00.000Z',
        end_at: '2026-10-13T11:00:00.000Z',
      });
      expect(attendeesOf(event.id)).toEqual([[U2, 'pending']]);
      // The exdate is the occurrence's original start, not the new one.
      expect(find(SERIES).exdates).toEqual([EXCLUDED, OCC]);
    });

    it('refuses a start that is not one of the series', async () => {
      const res = await moveOne({ occurrenceStart: '2026-10-13T05:00:00Z' });
      expect(res.status).toBe(400);
      expect(events()).toHaveLength(2);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('answers 409 for an occurrence already moved or removed', async () => {
      const res = await moveOne({ occurrenceStart: EXCLUDED });
      expect(res.status).toBe(409);
      expect(events()).toHaveLength(2);
    });

    it('deletes the copy again when the series was saved in between', async () => {
      concurrentEditAfterRead(SERIES);
      const res = await moveOne();
      expect(res.status).toBe(409);
      expect(events().map((r) => r.id)).toEqual([ONE, SERIES]);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('keeps the occurrence when the copy cannot be made', async () => {
      db.errors = {
        'calendar_event_attendees:insert': {
          code: '23514',
          message: 'Only a live staff member…',
        },
      };
      const res = await moveOne();
      expect(res.status).toBe(400);
      expect(events().map((r) => r.id)).toEqual([ONE, SERIES]);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('refuses someone who is not the organiser without making a copy', async () => {
      db.rls = creatorOnly(OTHER);
      mocks.getCurrentAccount.mockResolvedValue(ctx(OTHER));
      const res = await moveOne();
      expect(res.status).toBe(403);
      expect(events()).toHaveLength(2);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('refuses a repeat rule on a single occurrence', async () => {
      const res = await moveOne({ rrule: 'FREQ=DAILY' });
      expect(res.status).toBe(400);
      expect(events()).toHaveLength(2);
    });
  });

  describe('DELETE', () => {
    it('deletes a one-off event', async () => {
      const res = await del();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(events().map((r) => r.id)).toEqual([SERIES]);
    });

    it('deletes a whole series with scope all', async () => {
      expect((await del(SERIES, 'scope=all')).status).toBe(200);
      expect(events().map((r) => r.id)).toEqual([ONE]);
    });

    it('excludes one occurrence with scope this', async () => {
      const res = await del(
        SERIES,
        `scope=this&occurrenceStart=${encodeURIComponent('2026-10-12T09:00:00+04:00')}`
      );
      expect(res.status).toBe(200);
      expect(find(SERIES).exdates).toEqual([EXCLUDED, OCC]);
      // Again: already excluded, nothing to do.
      const again = await del(SERIES, `scope=this&occurrenceStart=${OCC}`);
      expect(again.status).toBe(200);
      expect(find(SERIES).exdates).toEqual([EXCLUDED, OCC]);
    });

    it('answers 409 when the series was saved in between', async () => {
      concurrentEditAfterRead(SERIES);
      const res = await del(SERIES, `scope=this&occurrenceStart=${OCC}`);
      expect(res.status).toBe(409);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('refuses a start that is not one of the series, or none at all', async () => {
      expect(
        (await del(SERIES, 'scope=this&occurrenceStart=2026-10-13T05:00:00Z'))
          .status
      ).toBe(400);
      expect((await del(SERIES, 'scope=this')).status).toBe(400);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('refuses someone who is not the organiser', async () => {
      db.rls = creatorOnly(OTHER);
      mocks.getCurrentAccount.mockResolvedValue(ctx(OTHER));
      expect((await del()).status).toBe(403);
      expect(
        (await del(SERIES, `scope=this&occurrenceStart=${OCC}`)).status
      ).toBe(403);
      expect(events()).toHaveLength(2);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
    });

    it('answers 403 when the policy refuses the delete (0 rows)', async () => {
      db.rls = { 'calendar_events:delete': () => false };
      const res = await del();
      expect(res.status).toBe(403);
      expect(events()).toHaveLength(2);
    });
  });
});
