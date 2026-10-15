import { beforeEach, describe, expect, it, vi } from 'vitest';

// One event: read it, change it (the row, or one occurrence of a series
// moved out into a standalone copy), delete it (the row, or one
// occurrence). Changes go through the calendar_* RPCs, scripted per test
// (`db.rpc`); the route's job is the arguments it sends and how it maps
// the answers. `rls` stands in for the creator-only DELETE policy.

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
/** PATCH with `expectedUpdatedAt: T1` unless the body says otherwise. */
const patch = (body: Record<string, unknown>, id = ONE) =>
  PATCH(
    new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ expectedUpdatedAt: T1, ...body }),
    }),
    params(id)
  );
/** DELETE with `expectedUpdatedAt=T1` unless `stamp` says otherwise. */
const del = (id = ONE, query = '', stamp: string | null = T1) =>
  DELETE(
    new Request(
      `http://x/?${query}${stamp ? `&expectedUpdatedAt=${encodeURIComponent(stamp)}` : ''}`,
      { method: 'DELETE' }
    ),
    params(id)
  );

const rpcCalls = () => db.rpcCalls ?? [];
const STALE = { code: 'P0001', message: 'stale' };

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
    beforeEach(() => {
      db.rpc = {
        calendar_update_event: (a) => ({
          data: { id: a.p_event, title: 'from the rpc' },
        }),
      };
    });

    it('sends only the changed keys and the attendee list, in one rpc', async () => {
      const res = await patch({ title: ' Review ', attendees: [U2] });
      expect(res.status).toBe(200);
      expect((await res.json()).event).toEqual({
        id: ONE,
        title: 'from the rpc',
      });
      expect(rpcCalls()).toEqual([
        [
          'calendar_update_event',
          {
            p_event: ONE,
            p_expected: T1,
            p_patch: { title: 'Review' },
            p_attendees: [U2],
          },
        ],
      ]);
      // Nothing is written outside the rpc.
      expect(find(ONE).title).toBe('Sync');
      expect(attendeesOf(ONE)).toEqual([[U1, 'accepted']]);
    });

    it('sends an empty patch for an attendees-only change, null attendees when none are sent', async () => {
      expect((await patch({ attendees: [U1, U2] })).status).toBe(200);
      expect((await patch({ color: 'red' })).status).toBe(200);
      expect(rpcCalls().map(([, a]) => [a.p_patch, a.p_attendees])).toEqual([
        [{}, [U1, U2]],
        [{ color: 'red' }, null],
      ]);
    });

    it('requires expectedUpdatedAt, and passes it on unchanged', async () => {
      for (const expectedUpdatedAt of [undefined, 'yesterday', 7]) {
        const res = await patch({ title: 'x', expectedUpdatedAt });
        expect(res.status).toBe(400);
      }
      expect(rpcCalls()).toEqual([]);

      const micro = '2026-10-01T08:00:00.123456+00:00';
      await patch({ title: 'x', expectedUpdatedAt: micro });
      expect(rpcCalls()[0][1].p_expected).toBe(micro);
    });

    it('moves the exdates with the series and recomputes its end', async () => {
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
      expect(rpcCalls()[0][1].p_patch).toEqual({
        start_at: '2026-10-05T08:00:00.000Z',
        end_at: '2026-10-05T08:30:00.000Z',
        all_day: false,
        time_zone: 'Europe/London',
        exdates: ['2026-10-19T08:00:00.000Z', '2026-11-02T09:00:00.000Z'],
        // Open-ended: no end.
        series_end_at: null,
      });
    });

    it('stores the end of a bounded series when the rule changes', async () => {
      const res = await patch(
        { rrule: 'FREQ=WEEKLY;COUNT=3', scope: 'all' },
        SERIES
      );
      expect(res.status).toBe(200);
      expect(rpcCalls()[0][1].p_patch).toEqual({
        rrule: 'FREQ=WEEKLY;COUNT=3',
        // 5, 12 and 19 October, 09:00–09:30 Dubai.
        series_end_at: '2026-10-19T05:30:00.000Z',
      });
    });

    it('checks a rule sent without times against the stored start', async () => {
      const res = await patch(
        { rrule: 'FREQ=WEEKLY;UNTIL=20200101T000000Z', scope: 'all' },
        SERIES
      );
      expect(res.status).toBe(400);
      expect(rpcCalls()).toEqual([]);
    });

    it('leaves the exdates and the end alone when the series keeps its times and rule', async () => {
      const res = await patch({ title: 'Daily', scope: 'all' }, SERIES);
      expect(res.status).toBe(200);
      expect(rpcCalls()[0][1].p_patch).toEqual({ title: 'Daily' });
    });

    it('answers 409 when the rpc finds the event changed (stale)', async () => {
      db.rpc!.calendar_update_event = () => ({ error: STALE });
      const res = await patch({ title: 'Late' }, SERIES);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This event was changed by someone else; reload',
      });
    });

    it('maps the rpc refusals: 42501 → 403, P0002 → 404, 23514 → 400', async () => {
      db.rpc!.calendar_update_event = () => ({ error: { code: '42501' } });
      let res = await patch({ title: 'Blocked' });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(
        'Only the organiser can change this event'
      );

      db.rpc!.calendar_update_event = () => ({
        error: { code: 'P0002', message: 'not_found' },
      });
      expect((await patch({ title: 'Gone' })).status).toBe(404);

      db.rpc!.calendar_update_event = () => ({
        error: { code: '23514', message: 'Only a live staff member…' },
      });
      res = await patch({ attendees: [U2] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Only a live staff member…');
    });

    it('refuses someone who is not the organiser before the rpc', async () => {
      mocks.getCurrentAccount.mockResolvedValue(ctx(OTHER));
      const res = await patch({ title: 'Mine now', attendees: [] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Only the organiser can change this event',
      });
      expect(rpcCalls()).toEqual([]);
    });

    it('refuses an empty or invalid patch before reading', async () => {
      expect((await patch({})).status).toBe(400);
      expect((await patch({ start: '2026-10-10T05:00:00Z' })).status).toBe(400);
      expect((await patch({ title: 'x' }, 'nope')).status).toBe(400);
      expect(rpcCalls()).toEqual([]);
    });
  });

  describe('PATCH one occurrence of a series', () => {
    beforeEach(() => {
      db.rpc = {
        calendar_split_occurrence: () => ({
          data: { id: 'copy-1', title: 'Standup (moved)', rrule: null },
        }),
      };
    });

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

    it('splits the occurrence off in one rpc and returns the copy', async () => {
      const res = await moveOne();
      expect(res.status).toBe(200);
      expect((await res.json()).event).toEqual({
        id: 'copy-1',
        title: 'Standup (moved)',
        rrule: null,
      });
      expect(rpcCalls()).toEqual([
        [
          'calendar_split_occurrence',
          {
            p_event: SERIES,
            p_expected: T1,
            p_occurrence_start: OCC,
            // The occurrence's own times, not the series' first.
            p_copy: {
              start_at: OCC,
              end_at: '2026-10-12T05:30:00.000Z',
              title: 'Standup (moved)',
            },
            p_attendees: null,
          },
        ],
      ]);
      // No copy or exdate written outside the rpc.
      expect(events()).toHaveLength(2);
      expect(find(SERIES).exdates).toEqual([EXCLUDED]);
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
      const args = rpcCalls()[0][1];
      expect(args.p_copy).toEqual({
        start_at: '2026-10-13T10:00:00.000Z',
        end_at: '2026-10-13T11:00:00.000Z',
        all_day: false,
        time_zone: 'Asia/Dubai',
        title: 'Standup (moved)',
      });
      // The exdate is the occurrence's original start, not the new one.
      expect(args.p_occurrence_start).toBe(OCC);
      expect(args.p_attendees).toEqual([U2]);
    });

    it('refuses a start that is not one of the series', async () => {
      const res = await moveOne({ occurrenceStart: '2026-10-13T05:00:00Z' });
      expect(res.status).toBe(400);
      expect(rpcCalls()).toEqual([]);
    });

    it('answers 409 for an occurrence already moved or removed', async () => {
      const res = await moveOne({ occurrenceStart: EXCLUDED });
      expect(res.status).toBe(409);
      expect(rpcCalls()).toEqual([]);
    });

    it('answers 409 when the rpc finds the series changed (stale)', async () => {
      db.rpc!.calendar_split_occurrence = () => ({ error: STALE });
      expect((await moveOne()).status).toBe(409);
    });

    it('answers 400 when the rpc refuses an attendee', async () => {
      db.rpc!.calendar_split_occurrence = () => ({
        error: { code: '23514', message: 'Only a live staff member…' },
      });
      expect((await moveOne({ attendees: [U2] })).status).toBe(400);
    });

    it('refuses someone who is not the organiser before the rpc', async () => {
      mocks.getCurrentAccount.mockResolvedValue(ctx(OTHER));
      expect((await moveOne()).status).toBe(403);
      expect(rpcCalls()).toEqual([]);
    });

    it('refuses a repeat rule on a single occurrence', async () => {
      expect((await moveOne({ rrule: 'FREQ=DAILY' })).status).toBe(400);
      expect(rpcCalls()).toEqual([]);
    });
  });

  describe('DELETE', () => {
    beforeEach(() => {
      db.rpc = { calendar_cancel_occurrence: () => ({ data: null }) };
    });

    it('deletes a one-off event that still has the expected stamp', async () => {
      const res = await del();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(events().map((r) => r.id)).toEqual([SERIES]);
    });

    it('deletes a whole series with scope all', async () => {
      expect((await del(SERIES, 'scope=all')).status).toBe(200);
      expect(events().map((r) => r.id)).toEqual([ONE]);
    });

    it('requires expectedUpdatedAt', async () => {
      expect((await del(ONE, '', null)).status).toBe(400);
      expect((await del(ONE, '', 'soon')).status).toBe(400);
      expect(events()).toHaveLength(2);
    });

    it('answers 409, deleting nothing, when the event changed since it was read', async () => {
      const res = await del(ONE, '', T2);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This event was changed by someone else; reload',
      });
      expect(events()).toHaveLength(2);
    });

    it('cancels one occurrence with scope this, in one rpc', async () => {
      const res = await del(
        SERIES,
        `scope=this&occurrenceStart=${encodeURIComponent('2026-10-12T09:00:00+04:00')}`
      );
      expect(res.status).toBe(200);
      expect(rpcCalls()).toEqual([
        [
          'calendar_cancel_occurrence',
          { p_event: SERIES, p_expected: T1, p_occurrence_start: OCC },
        ],
      ]);
      // Already excluded: nothing to do.
      const again = await del(SERIES, `scope=this&occurrenceStart=${EXCLUDED}`);
      expect(again.status).toBe(200);
      expect(rpcCalls()).toHaveLength(1);
    });

    it('answers 409 when the rpc finds the series changed (stale)', async () => {
      db.rpc!.calendar_cancel_occurrence = () => ({ error: STALE });
      const res = await del(SERIES, `scope=this&occurrenceStart=${OCC}`);
      expect(res.status).toBe(409);
    });

    it('refuses a start that is not one of the series, or none at all', async () => {
      expect(
        (await del(SERIES, 'scope=this&occurrenceStart=2026-10-13T05:00:00Z'))
          .status
      ).toBe(400);
      expect((await del(SERIES, 'scope=this')).status).toBe(400);
      expect(rpcCalls()).toEqual([]);
    });

    it('refuses someone who is not the organiser', async () => {
      db.rls = creatorOnly(OTHER);
      mocks.getCurrentAccount.mockResolvedValue(ctx(OTHER));
      expect((await del()).status).toBe(403);
      expect(
        (await del(SERIES, `scope=this&occurrenceStart=${OCC}`)).status
      ).toBe(403);
      expect(events()).toHaveLength(2);
      expect(rpcCalls()).toEqual([]);
    });

    it('answers 403 when the policy refuses the delete (0 rows)', async () => {
      db.rls = { 'calendar_events:delete': () => false };
      const res = await del();
      expect(res.status).toBe(403);
      expect(events()).toHaveLength(2);
    });
  });
});
