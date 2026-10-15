// ============================================================
// POST /api/calendar/events — create an event (migration 108).
// Staff only (`requireCalendarUser`). The event and its invitees are
// written under the caller's RLS client, all or nothing.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  ATTENDEE_COLUMNS,
  calendarDbErrorResponse,
  EVENT_COLUMNS,
  requireCalendarUser,
} from '@/lib/calendar/server';
import { seriesEndAt } from '@/lib/calendar/recurrence';
import { parseEventInput, type EventInput } from '@/lib/calendar/validate';
import { jsonError, readJson } from '@/lib/meetings/server';

/** POST → 201 `{ event, attendees }`, the caller as organiser and every
 *  invitee `pending`. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireCalendarUser();
    const parsed = parseEventInput(await readJson(request), {
      creatorId: userId,
    });
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const v = parsed.value as EventInput;

    const { data, error } = await supabase
      .from('calendar_events')
      .insert({
        account_id: accountId,
        created_by: userId,
        title: v.title,
        description: v.description,
        location: v.location,
        start_at: v.start_at,
        end_at: v.end_at,
        all_day: v.all_day,
        time_zone: v.time_zone,
        color: v.color,
        visibility: v.visibility,
        reminders: v.reminders,
        rrule: v.rrule,
        // NULL for a one-off or open-ended series (the reminder sweep's
        // and the feed's bound).
        series_end_at: seriesEndAt(v)?.toISOString() ?? null,
      })
      .select(EVENT_COLUMNS)
      .single();
    if (error) return calendarDbErrorResponse(error, 'Failed to create event');
    const event = data as unknown as { id: string };

    let attendees: unknown[] = [];
    if (v.attendees.length > 0) {
      const { data: rows, error: attErr } = await supabase
        .from('calendar_event_attendees')
        .insert(
          v.attendees.map((user_id) => ({
            event_id: event.id,
            account_id: accountId,
            user_id,
            response: 'pending',
          }))
        )
        .select(ATTENDEE_COLUMNS);
      if (attErr) {
        // All or nothing: a refused invitee (another workspace, a guest)
        // must not leave a half-made event behind.
        await supabase.from('calendar_events').delete().eq('id', event.id);
        return calendarDbErrorResponse(attErr, 'Failed to invite people');
      }
      attendees = rows ?? [];
    }
    return NextResponse.json({ event, attendees }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
