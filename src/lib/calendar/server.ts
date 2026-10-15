// ============================================================
// Calendar API — server-side helpers shared by the route handlers
// (migration 108). Every read and write goes through the caller's RLS
// client; nothing here uses the service role.
// ============================================================

import { NextResponse } from 'next/server';

import { ForbiddenError, type AccountContext } from '@/lib/auth/account';
import {
  jsonError,
  requireMeetingsUser,
  STAFF_ONLY,
} from '@/lib/meetings/server';

export const CALENDAR_STAFF_ONLY = 'The calendar is for staff only';

/** Every column of a calendar_events row (the create/read response). */
export const EVENT_COLUMNS =
  'id, account_id, created_by, title, description, location, start_at, end_at, all_day, time_zone, color, rrule, exdates, visibility, reminders, status, created_at, updated_at';

/** The columns `buildFeed` reads (`FeedEventRow`). */
export const FEED_EVENT_COLUMNS =
  'id, created_by, title, location, start_at, end_at, all_day, time_zone, color, rrule, exdates, status';

export const ATTENDEE_COLUMNS =
  'event_id, user_id, account_id, response, reminders, responded_at';

/** The columns `buildFeed` reads (`FeedMeetingRow`). */
export const FEED_MEETING_COLUMNS =
  'id, title, scheduled_start, scheduled_end, host_user_id, status';

/**
 * The caller's context, refused for a bank guest. Same gate as the
 * meetings (viewer and up, never `bank_guest`); only the staff-only
 * refusal is reworded for this screen.
 */
export async function requireCalendarUser(): Promise<AccountContext> {
  try {
    return await requireMeetingsUser();
  } catch (err) {
    if (err instanceof ForbiddenError && err.message === STAFF_ONLY) {
      throw new ForbiddenError(CALENDAR_STAFF_ONLY);
    }
    throw err;
  }
}

/** A refused or failed write, mapped like `meetingDbErrorResponse`. */
export function calendarDbErrorResponse(
  error: { code?: string; message?: string },
  fallback: string
): NextResponse {
  switch (error.code) {
    case '42501':
      return jsonError("You can't make that change to this event", 403);
    case '23514':
    case 'P0001':
    case '22023':
      return jsonError(error.message || fallback, 400);
    case '23503':
      return jsonError('A person or event was not found', 400);
    case '22P02':
    case '22007':
    case '22008':
      return jsonError('Invalid value', 400);
    default:
      console.error('[calendar]', fallback, error);
      return jsonError(fallback, 500);
  }
}
