// ============================================================
// GET /api/calendar/feed — the merged calendar (migration 108).
//
// RLS lets an owner or admin read every event and meeting in the
// workspace, so "visible" is not "mine": each source is selected
// explicitly. Events: the ones I created, the ones I am invited to,
// and confirmed workspace-visible ones. Meetings: hosted by me or
// inviting me (scheduled or ended), plus open-to-workspace scheduled
// ones on request. Tasks: my open ones due in the range.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  buildFeed,
  MEETING_DEFAULT_MS,
  type FeedAttendeeRow,
  type FeedEventRow,
  type FeedMeetingRow,
  type FeedTaskRow,
} from '@/lib/calendar/feed';
import { MAX_RANGE_DAYS } from '@/lib/calendar/recurrence';
import {
  FEED_EVENT_COLUMNS,
  FEED_MEETING_COLUMNS,
  requireCalendarUser,
} from '@/lib/calendar/server';
import { chunk } from '@/lib/calendar/util';
import { jsonError, readErrorResponse } from '@/lib/meetings/server';

const ISO_START = /^\d{4}-\d{2}-\d{2}/;
const DAY_MS = 86_400_000;
/** Ids per `.in()` read: a long list would overflow the request URL. */
const IN_BATCH = 100;
/** Attendee rows per page. */
const ATTENDEE_PAGE = 1000;

function instant(value: string | null): number | null {
  if (!value || !ISO_START.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

type Result<T> = { data: T[] | null; error: unknown };

/**
 * GET /api/calendar/feed?from=ISO&to=ISO[&includeWorkspaceMeetings=1]
 * → `{ items: FeedItem[] }`. `to` must be after `from`, the span at most
 * `MAX_RANGE_DAYS` days.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireCalendarUser();
    const params = new URL(request.url).searchParams;
    const fromMs = instant(params.get('from'));
    const toMs = instant(params.get('to'));
    if (fromMs === null || toMs === null) {
      return jsonError('from and to must be ISO dates', 400);
    }
    if (toMs <= fromMs) return jsonError('to must be after from', 400);
    if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
      return jsonError(
        `The range may span at most ${MAX_RANGE_DAYS} days`,
        400
      );
    }
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    // A series may start long before `from`, so it is not filtered on its
    // start; but one that ended before `from` has nothing to show
    // (series_end_at is NULL for an unbounded series). buildFeed expands
    // what is left over the range.
    const eventRange = `and(rrule.not.is.null,or(series_end_at.is.null,series_end_at.gt.${from})),and(start_at.lt.${to},end_at.gt.${from})`;
    // A meeting with no end is drawn as MEETING_DEFAULT_MS long.
    const meetingRange = `scheduled_end.gt.${from},scheduled_start.gte.${new Date(
      fromMs - MEETING_DEFAULT_MS
    ).toISOString()}`;
    const meetingStatuses = ['scheduled', 'ended'];

    const events = () =>
      supabase
        .from('calendar_events')
        .select(FEED_EVENT_COLUMNS)
        .eq('account_id', accountId)
        .eq('status', 'confirmed')
        .or(eventRange);
    const meetings = () =>
      supabase
        .from('meetings')
        .select(FEED_MEETING_COLUMNS)
        .eq('account_id', accountId)
        .not('scheduled_start', 'is', null)
        .lt('scheduled_start', to)
        .or(meetingRange);

    const includeWorkspace = params.get('includeWorkspaceMeetings') === '1';
    const [
      created,
      invited,
      workspace,
      hosted,
      meetingInvites,
      openMeetings,
      tasks,
    ] = (await Promise.all([
      events().eq('created_by', userId),
      supabase
        .from('calendar_event_attendees')
        .select(`response, calendar_events!inner(${FEED_EVENT_COLUMNS})`)
        .eq('account_id', accountId)
        .eq('user_id', userId)
        .eq('calendar_events.status', 'confirmed')
        .or(eventRange, { referencedTable: 'calendar_events' }),
      events().eq('visibility', 'workspace'),
      meetings().eq('host_user_id', userId).in('status', meetingStatuses),
      supabase
        .from('meeting_invitees')
        .select(`meetings!inner(${FEED_MEETING_COLUMNS})`)
        .eq('user_id', userId)
        .eq('meetings.account_id', accountId)
        .in('meetings.status', meetingStatuses)
        .not('meetings.scheduled_start', 'is', null)
        .lt('meetings.scheduled_start', to)
        .or(meetingRange, { referencedTable: 'meetings' }),
      includeWorkspace
        ? meetings().eq('open_to_workspace', true).eq('status', 'scheduled')
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from('tasks')
        .select('id, title, due_at, contact_id')
        .eq('account_id', accountId)
        .eq('status', 'open')
        .eq('assigned_to', userId)
        .gte('due_at', from)
        .lt('due_at', to),
    ])) as Result<unknown>[];
    for (const r of [
      created,
      invited,
      workspace,
      hosted,
      meetingInvites,
      openMeetings,
      tasks,
    ]) {
      if (r.error) return readErrorResponse(r.error);
    }

    const eventsById = new Map<string, FeedEventRow>();
    // The caller's own answer travels with the read that found the event,
    // so the paged read below can never lose it.
    const mine: FeedAttendeeRow[] = [];
    const embedded = (invited.data ?? []).map((r) => {
      const row = r as {
        response: FeedAttendeeRow['response'];
        calendar_events: FeedEventRow;
      };
      if (row.calendar_events) {
        mine.push({
          event_id: row.calendar_events.id,
          user_id: userId,
          response: row.response,
        });
      }
      return row.calendar_events;
    });
    for (const e of [
      ...((created.data ?? []) as FeedEventRow[]),
      ...embedded,
      ...((workspace.data ?? []) as FeedEventRow[]),
    ]) {
      if (e) eventsById.set(e.id, e);
    }

    const meetingsById = new Map<string, FeedMeetingRow>();
    for (const m of [
      ...((hosted.data ?? []) as FeedMeetingRow[]),
      ...(meetingInvites.data ?? []).map(
        (r) => (r as { meetings: FeedMeetingRow }).meetings
      ),
      ...((openMeetings.data ?? []) as FeedMeetingRow[]),
    ]) {
      if (m) meetingsById.set(m.id, m);
    }

    // Paged and ordered: PostgREST cuts a read at its row cap, and 100
    // events can hold more attendees than that. Stops on a short page, so
    // `max-rows` must stay at or above ATTENDEE_PAGE (PostgREST's is 1000).
    const attendeeRows: FeedAttendeeRow[] = [];
    const batches = await Promise.all(
      chunk([...eventsById.keys()], IN_BATCH).map(async (ids) => {
        const rows: FeedAttendeeRow[] = [];
        for (;;) {
          const { data, error } = await supabase
            .from('calendar_event_attendees')
            .select('event_id, user_id, response')
            .in('event_id', ids)
            .order('event_id')
            .order('user_id')
            .range(rows.length, rows.length + ATTENDEE_PAGE - 1);
          if (error) return { rows, error };
          rows.push(...((data ?? []) as FeedAttendeeRow[]));
          if (!data || data.length < ATTENDEE_PAGE)
            return { rows, error: null };
        }
      })
    );
    for (const { rows, error } of batches) {
      if (error) return readErrorResponse(error);
      attendeeRows.push(...rows);
    }
    const have = new Set(attendeeRows.map((a) => `${a.event_id}:${a.user_id}`));
    for (const a of mine) {
      if (!have.has(`${a.event_id}:${a.user_id}`)) attendeeRows.push(a);
    }

    return NextResponse.json({
      items: buildFeed({
        events: [...eventsById.values()],
        attendeeRows,
        meetings: [...meetingsById.values()],
        tasks: (tasks.data ?? []) as FeedTaskRow[],
        me: userId,
        fromMs,
        toMs,
      }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
