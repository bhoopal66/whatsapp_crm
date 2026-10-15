// ============================================================
// /api/calendar/events/[id] — read, change and delete one event
// (migration 108). Everything runs under the caller's RLS client: an
// event is edited or deleted by its creator only.
//
// A recurring series' `exdates` hold the start instants of occurrences
// that were removed or moved out into a standalone copy; the reminder
// sweep compares them exactly. Every write is a compare-and-set on the
// `updated_at` the caller last read (`expectedUpdatedAt`, stamped by the
// guard trigger), done in one transaction by the calendar_* RPCs, so
// two people editing one series cannot drop each other's exceptions and
// a failure never leaves a half-made copy behind.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  expandEvent,
  fromFloating,
  isOccurrence,
  rruleSanity,
  seriesEndAt,
  toFloating,
} from '@/lib/calendar/recurrence';
import {
  calendarDbErrorResponse,
  EVENT_COLUMNS,
  requireCalendarUser,
} from '@/lib/calendar/server';
import {
  expectedStamp,
  parseEventInput,
  type EventInput,
} from '@/lib/calendar/validate';
import { isUuid } from '@/lib/meetings/requests';
import {
  jsonError,
  readErrorResponse,
  readJson,
  type Params,
} from '@/lib/meetings/server';

type Db = Awaited<ReturnType<typeof requireCalendarUser>>['supabase'];

interface EventRow {
  id: string;
  account_id: string;
  created_by: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  time_zone: string;
  color: string;
  rrule: string | null;
  exdates: string[] | null;
  visibility: string;
  reminders: number[];
  status: string;
  updated_at: string;
}

const NOT_ORGANISER = 'Only the organiser can change this event';
const CHANGED_ELSEWHERE = 'This event was changed by someone else; reload';
const NO_STAMP = "expectedUpdatedAt is required (the event's updated_at)";

/** The patch keys that are columns of the event row itself. */
const ROW_KEYS = [
  'title',
  'description',
  'location',
  'start_at',
  'end_at',
  'all_day',
  'time_zone',
  'color',
  'visibility',
  'reminders',
  'rrule',
] as const;

/** The keys a standalone copy of one occurrence may override. */
const COPY_KEYS = [
  'title',
  'description',
  'location',
  'start_at',
  'end_at',
  'all_day',
  'time_zone',
  'color',
  'visibility',
  'reminders',
] as const;

async function loadEvent(supabase: Db, id: string) {
  const { data, error } = await supabase
    .from('calendar_events')
    .select(EVENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  return { event: data as unknown as EventRow | null, error };
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/**
 * A delete of a visible event that touched no row. RLS hides nothing
 * here (the event was just read), so it is a concurrent change (409),
 * the row having gone (404), or the policy refusing the caller (403).
 */
async function noRowsResponse(
  supabase: Db,
  id: string,
  expected: string
): Promise<NextResponse> {
  const { event, error } = await loadEvent(supabase, id);
  if (error) return readErrorResponse(error);
  if (!event) return jsonError('Event not found', 404);
  if (!sameInstant(event.updated_at, expected)) {
    return jsonError(CHANGED_ELSEWHERE, 409);
  }
  return jsonError(NOT_ORGANISER, 403);
}

/** A refused or failed calendar_* RPC (the write contract's codes). */
function rpcErrorResponse(
  error: { code?: string; message?: string },
  fallback: string
): NextResponse {
  if (error.code === 'P0001' && /^stale\b/.test(error.message ?? '')) {
    return jsonError(CHANGED_ELSEWHERE, 409);
  }
  if (error.code === '42501') return jsonError(NOT_ORGANISER, 403);
  if (error.code === 'P0002') return jsonError('Event not found', 404);
  return calendarDbErrorResponse(error, fallback);
}

/**
 * The series' exdates moved with its start: the same wall-clock delta,
 * so an excluded "Tuesday 09:00" stays the Tuesday occurrence after the
 * series moves to 10:00 or to another zone.
 */
function shiftExdates(ev: EventRow, startAt: string, timeZone: string) {
  const delta =
    toFloating(Date.parse(startAt), timeZone) -
    toFloating(Date.parse(ev.start_at), ev.time_zone);
  return (ev.exdates ?? []).map((x) =>
    new Date(
      fromFloating(toFloating(Date.parse(x), ev.time_zone) + delta, timeZone)
    ).toISOString()
  );
}

/** The checked occurrence (original start and end), or null. */
function findOccurrence(ev: EventRow, startIso: string) {
  const start = Date.parse(startIso);
  if (!isOccurrence(ev, start)) return null;
  return (
    expandEvent({ ...ev, exdates: [] }, start, start + 1).occurrences.find(
      (o) => o.start === start
    ) ?? null
  );
}

const excluded = (ev: EventRow, startIso: string) =>
  (ev.exdates ?? []).some((x) => sameInstant(x, startIso));

/** GET → `{ event, attendees: [{ user_id, response, responded_at }],
 *  canEdit }`; 404 when the caller cannot see it. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireCalendarUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid event id', 400);

    const { event, error } = await loadEvent(supabase, id);
    if (error) return readErrorResponse(error);
    if (!event) return jsonError('Event not found', 404);

    const { data: attendees, error: attErr } = await supabase
      .from('calendar_event_attendees')
      .select('user_id, response, responded_at')
      .eq('event_id', id);
    if (attErr) return readErrorResponse(attErr);

    return NextResponse.json({
      event,
      attendees: attendees ?? [],
      canEdit: event.created_by === userId,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH `{ …event fields (partial), attendees?, scope?: 'this'|'all',
 * occurrenceStart?, expectedUpdatedAt }` → `{ event }`. On a series,
 * scope 'this' moves one occurrence out into a standalone copy
 * (returned); otherwise the row itself is updated (returned).
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireCalendarUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid event id', 400);
    const raw = await readJson(request);
    const parsed = parseEventInput(raw, { partial: true, creatorId: userId });
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const expected = expectedStamp(
      (raw as { expectedUpdatedAt?: unknown }).expectedUpdatedAt
    );
    if (!expected) return jsonError(NO_STAMP, 400);
    const v = parsed.value;
    const changes: Record<string, unknown> = {};
    for (const k of ROW_KEYS) if (v[k] !== undefined) changes[k] = v[k];
    if (Object.keys(changes).length === 0 && v.attendees === undefined) {
      return jsonError('Nothing to change', 400);
    }

    const { event: ev, error } = await loadEvent(supabase, id);
    if (error) return readErrorResponse(error);
    if (!ev) return jsonError('Event not found', 404);
    // The RPCs refuse it too; refusing first spares the work.
    if (ev.created_by !== userId) return jsonError(NOT_ORGANISER, 403);

    if (ev.rrule && v.scope === 'this') {
      return patchOccurrence(supabase, ev, v, expected);
    }

    // A rule sent without times is checked against the stored start
    // (parseEventInput checks it when the times travel with it).
    if (v.rrule && v.start_at === undefined) {
      const err = rruleSanity(v.rrule, ev);
      if (err) return jsonError(err, 400);
    }
    if (v.start_at !== undefined || v.rrule !== undefined) {
      changes.series_end_at =
        seriesEndAt({
          start_at: v.start_at ?? ev.start_at,
          end_at: v.end_at ?? ev.end_at,
          all_day: v.all_day ?? ev.all_day,
          time_zone: v.time_zone ?? ev.time_zone,
          rrule: v.rrule !== undefined ? v.rrule : ev.rrule,
        })?.toISOString() ?? null;
    }
    if (
      ev.rrule &&
      (ev.exdates ?? []).length > 0 &&
      v.start_at !== undefined &&
      v.time_zone !== undefined &&
      (!sameInstant(v.start_at, ev.start_at) || v.time_zone !== ev.time_zone)
    ) {
      changes.exdates = shiftExdates(ev, v.start_at, v.time_zone);
    }

    const { data, error: rpcErr } = await supabase.rpc(
      'calendar_update_event',
      {
        p_event: id,
        p_expected: expected,
        p_patch: changes,
        p_attendees: v.attendees ?? null,
      }
    );
    if (rpcErr) return rpcErrorResponse(rpcErr, 'Failed to update event');
    return NextResponse.json({ event: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * One occurrence of a series changed: calendar_split_occurrence makes a
 * standalone copy with the changes and its people, and excludes the
 * occurrence from the series, in one transaction.
 */
async function patchOccurrence(
  supabase: Db,
  ev: EventRow,
  v: Partial<EventInput>,
  expected: string
): Promise<NextResponse> {
  const occStart = v.occurrenceStart!;
  if (v.rrule) {
    return jsonError('One occurrence cannot repeat on its own', 400);
  }
  const occ = findOccurrence(ev, occStart);
  if (!occ) return jsonError('Not an occurrence of this event', 400);
  if (excluded(ev, occStart)) return jsonError(CHANGED_ELSEWHERE, 409);

  // The copy takes the series' fields unless overridden, so the
  // occurrence's own times always travel (the series' are its first).
  const copy: Record<string, unknown> = {
    start_at: new Date(occ.start).toISOString(),
    end_at: new Date(occ.end).toISOString(),
  };
  for (const k of COPY_KEYS) if (v[k] !== undefined) copy[k] = v[k];

  const { data, error } = await supabase.rpc('calendar_split_occurrence', {
    p_event: ev.id,
    p_expected: expected,
    p_occurrence_start: occStart,
    p_copy: copy,
    p_attendees: v.attendees ?? null,
  });
  if (error) return rpcErrorResponse(error, 'Failed to update event');
  return NextResponse.json({ event: data });
}

/**
 * DELETE `?scope=this|all&occurrenceStart=ISO&expectedUpdatedAt=…` →
 * `{ ok: true }`. On a series, scope 'this' excludes one occurrence;
 * otherwise the row goes (its attendees cascade).
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireCalendarUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid event id', 400);
    const q = new URL(request.url).searchParams;
    const parsed = parseEventInput(
      {
        scope: q.get('scope') ?? undefined,
        occurrenceStart: q.get('occurrenceStart') ?? undefined,
      },
      { partial: true }
    );
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { scope, occurrenceStart } = parsed.value;
    const expected = expectedStamp(q.get('expectedUpdatedAt'));
    if (!expected) return jsonError(NO_STAMP, 400);

    const { event: ev, error } = await loadEvent(supabase, id);
    if (error) return readErrorResponse(error);
    if (!ev) return jsonError('Event not found', 404);
    if (ev.created_by !== userId) return jsonError(NOT_ORGANISER, 403);

    if (ev.rrule && scope === 'this') {
      if (!findOccurrence(ev, occurrenceStart!)) {
        return jsonError('Not an occurrence of this event', 400);
      }
      if (excluded(ev, occurrenceStart!)) {
        return NextResponse.json({ ok: true });
      }
      const { error: rpcErr } = await supabase.rpc(
        'calendar_cancel_occurrence',
        {
          p_event: id,
          p_expected: expected,
          p_occurrence_start: occurrenceStart!,
        }
      );
      if (rpcErr) return rpcErrorResponse(rpcErr, 'Failed to delete event');
      return NextResponse.json({ ok: true });
    }

    const { data, error: delErr } = await supabase
      .from('calendar_events')
      .delete()
      .eq('id', id)
      .eq('updated_at', expected)
      .select('id');
    if (delErr) return rpcErrorResponse(delErr, 'Failed to delete event');
    if (!data || data.length === 0) {
      return noRowsResponse(supabase, id, expected);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
