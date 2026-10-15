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
import { jsonError, readErrorResponse } from '@/lib/meetings/server';

const ISO_START = /^\d{4}-\d{2}-\d{2}/;
const DAY_MS = 86_400_000;

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
    // A series may start long before `from`, so a recurring event is
    // never range-filtered in SQL; buildFeed expands it over the range.
    const eventRange = `rrule.not.is.null,and(start_at.lt.${to},end_at.gt.${from})`;
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
        .select(`calendar_events!inner(${FEED_EVENT_COLUMNS})`)
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
    const embedded = (invited.data ?? []).map(
      (r) => (r as { calendar_events: FeedEventRow }).calendar_events
    );
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

    let attendeeRows: FeedAttendeeRow[] = [];
    if (eventsById.size > 0) {
      const { data, error } = await supabase
        .from('calendar_event_attendees')
        .select('event_id, user_id, response')
        .in('event_id', [...eventsById.keys()]);
      if (error) return readErrorResponse(error);
      attendeeRows = (data ?? []) as FeedAttendeeRow[];
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
