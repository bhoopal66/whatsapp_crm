// ============================================================
// PUT /api/calendar/events/[id]/response — answer an invitation
// (migration 108). Only the caller's own attendee row is touched; the
// column grants let an attendee change nothing but `response` and
// `reminders`, and the trigger stamps `responded_at`.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  calendarDbErrorResponse,
  requireCalendarUser,
} from '@/lib/calendar/server';
import { parseEventInput } from '@/lib/calendar/validate';
import { isUuid } from '@/lib/meetings/requests';
import { jsonError, readJson, type Params } from '@/lib/meetings/server';

const RESPONSES = ['accepted', 'tentative', 'declined'] as const;
type Answer = (typeof RESPONSES)[number];

/**
 * PUT `{ response: 'accepted'|'tentative'|'declined', reminders?: int[] |
 * null }` → `{ ok: true, response }`. `reminders: null` falls back to the
 * event's own; absent leaves the caller's current choice alone.
 */
export async function PUT(request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireCalendarUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid event id', 400);
    const body = (await readJson(request)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonError('Expected a JSON object', 400);
    }
    const response = body.response as Answer;
    if (!RESPONSES.includes(response)) {
      return jsonError('response must be accepted, tentative or declined', 400);
    }
    const patch: { response: Answer; reminders?: number[] | null } = {
      response,
    };
    if (body.reminders === null) {
      patch.reminders = null;
    } else if (body.reminders !== undefined) {
      const parsed = parseEventInput(
        { reminders: body.reminders },
        { partial: true }
      );
      if (!parsed.ok) return jsonError(parsed.error, 400);
      patch.reminders = parsed.value.reminders!;
    }

    const { data, error } = await supabase
      .from('calendar_event_attendees')
      .update(patch)
      .eq('event_id', id)
      .eq('user_id', userId)
      .select('event_id');
    if (error) return calendarDbErrorResponse(error, 'Failed to respond');
    if (!data || data.length === 0) {
      return jsonError('You are not invited to this event', 404);
    }
    return NextResponse.json({ ok: true, response });
  } catch (err) {
    return toErrorResponse(err);
  }
}
