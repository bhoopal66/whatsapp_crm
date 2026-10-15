// ============================================================
// /api/calendar/events/[id] — read, change and delete one event
// (migration 108). Everything runs under the caller's RLS client: an
// event is edited or deleted by its creator only, so a refused write
// comes back as 0 rows (or 42501) and is answered 403.
//
// A recurring series' `exdates` hold the start instants of occurrences
// that were removed or moved out into a standalone copy; the reminder
// sweep compares them exactly. Every write that touches them is a
// compare-and-set on `updated_at` (stamped by the guard trigger), so two
// people editing one series cannot drop each other's exceptions.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  isOccurrence,
  expandEvent,
  fromFloating,
  toFloating,
} from '@/lib/calendar/recurrence';
import {
  calendarDbErrorResponse,
  EVENT_COLUMNS,
  requireCalendarUser,
} from '@/lib/calendar/server';
import { parseEventInput, type EventInput } from '@/lib/calendar/validate';
import { diffInvitees, isUuid } from '@/lib/meetings/requests';
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

async function loadEvent(supabase: Db, id: string) {
  const { data, error } = await supabase
    .from('calendar_events')
    .select(EVENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  return { event: data as unknown as EventRow | null, error };
}

async function loadAttendeeIds(supabase: Db, id: string) {
  const { data, error } = await supabase
    .from('calendar_event_attendees')
    .select('user_id')
    .eq('event_id', id);
  return {
    ids: ((data ?? []) as { user_id: string }[]).map((r) => r.user_id),
    error,
  };
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/**
 * A write to a visible event that touched no row. RLS hides nothing
 * here (the event was just read), so it is a concurrent change (409),
 * the row having gone (404), or the policy refusing the caller (403).
 */
async function noRowsResponse(
  supabase: Db,
  loaded: EventRow
): Promise<NextResponse> {
  const { event, error } = await loadEvent(supabase, loaded.id);
  if (error) return readErrorResponse(error);
  if (!event) return jsonError('Event not found', 404);
  if (!sameInstant(event.updated_at, loaded.updated_at)) {
    return jsonError(CHANGED_ELSEWHERE, 409);
  }
  return jsonError(NOT_ORGANISER, 403);
}

/** A refused or failed write to the event row. */
function writeErrorResponse(
  error: { code?: string; message?: string },
  fallback: string
): NextResponse {
  if (error.code === '42501') return jsonError(NOT_ORGANISER, 403);
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

/** Appends one occurrence start to the series' exdates, compare-and-set. */
async function appendExdate(supabase: Db, ev: EventRow, start: string) {
  return supabase
    .from('calendar_events')
    .update({ exdates: [...(ev.exdates ?? []), start] })
    .eq('id', ev.id)
    .eq('updated_at', ev.updated_at)
    .select('id');
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
 * occurrenceStart? }` → `{ event }`. On a series, scope 'this' moves one
 * occurrence out into a standalone copy (returned); otherwise the row
 * itself is updated (returned).
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, userId, accountId } = await requireCalendarUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid event id', 400);
    const parsed = parseEventInput(await readJson(request), {
      partial: true,
      creatorId: userId,
    });
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const v = parsed.value;
    const changes: Partial<Record<(typeof ROW_KEYS)[number], unknown>> = {};
    for (const k of ROW_KEYS) if (v[k] !== undefined) changes[k] = v[k];
    if (Object.keys(changes).length === 0 && v.attendees === undefined) {
      return jsonError('Nothing to change', 400);
    }

    const { event: ev, error } = await loadEvent(supabase, id);
    if (error) return readErrorResponse(error);
    if (!ev) return jsonError('Event not found', 404);
    // RLS would refuse the write anyway; refusing first keeps a
    // non-organiser from creating (and ringing invitees for) a copy.
    if (ev.created_by !== userId) return jsonError(NOT_ORGANISER, 403);

    if (ev.rrule && v.scope === 'this') {
      return patchOccurrence(supabase, ev, v, accountId, userId);
    }

    const update: Record<string, unknown> = { ...changes };
    if (
      ev.rrule &&
      (ev.exdates ?? []).length > 0 &&
      v.start_at !== undefined &&
      v.time_zone !== undefined &&
      (!sameInstant(v.start_at, ev.start_at) || v.time_zone !== ev.time_zone)
    ) {
      update.exdates = shiftExdates(ev, v.start_at, v.time_zone);
    }
    // An attendees-only change still goes through the row: the same
    // organiser and compare-and-set checks (the trigger restamps it).
    if (Object.keys(update).length === 0) update.updated_at = ev.updated_at;

    const { data, error: upErr } = await supabase
      .from('calendar_events')
      .update(update)
      .eq('id', id)
      .eq('updated_at', ev.updated_at)
      .select(EVENT_COLUMNS);
    if (upErr) return writeErrorResponse(upErr, 'Failed to update event');
    const updated = (data ?? [])[0];
    if (!updated) return noRowsResponse(supabase, ev);

    if (v.attendees !== undefined) {
      const current = await loadAttendeeIds(supabase, id);
      if (current.error) return readErrorResponse(current.error);
      const { add, remove } = diffInvitees(current.ids, v.attendees);
      if (remove.length > 0) {
        const { error: delErr } = await supabase
          .from('calendar_event_attendees')
          .delete()
          .eq('event_id', id)
          .in('user_id', remove);
        if (delErr) {
          return calendarDbErrorResponse(delErr, 'Failed to remove people');
        }
      }
      if (add.length > 0) {
        const { error: insErr } = await supabase
          .from('calendar_event_attendees')
          .insert(
            add.map((user_id) => ({
              event_id: id,
              account_id: ev.account_id,
              user_id,
              response: 'pending',
            }))
          );
        if (insErr) {
          return calendarDbErrorResponse(insErr, 'Failed to invite people');
        }
      }
    }
    return NextResponse.json({ event: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * One occurrence of a series changed: a standalone copy with the
 * changes, its invitees, and only then the occurrence excluded from the
 * series. The copy goes first so a failure never loses the occurrence;
 * if the exclusion fails the copy is deleted again (its attendees
 * cascade).
 */
async function patchOccurrence(
  supabase: Db,
  ev: EventRow,
  v: Partial<EventInput>,
  accountId: string,
  userId: string
): Promise<NextResponse> {
  const occStart = v.occurrenceStart!;
  if (v.rrule) {
    return jsonError('One occurrence cannot repeat on its own', 400);
  }
  const occ = findOccurrence(ev, occStart);
  if (!occ) return jsonError('Not an occurrence of this event', 400);
  if (excluded(ev, occStart)) return jsonError(CHANGED_ELSEWHERE, 409);

  let attendees = v.attendees;
  if (attendees === undefined) {
    const current = await loadAttendeeIds(supabase, ev.id);
    if (current.error) return readErrorResponse(current.error);
    attendees = current.ids;
  }

  const { data: copy, error } = await supabase
    .from('calendar_events')
    .insert({
      account_id: accountId,
      created_by: userId,
      title: v.title ?? ev.title,
      description: v.description !== undefined ? v.description : ev.description,
      location: v.location !== undefined ? v.location : ev.location,
      start_at: v.start_at ?? new Date(occ.start).toISOString(),
      end_at: v.end_at ?? new Date(occ.end).toISOString(),
      all_day: v.all_day ?? ev.all_day,
      time_zone: v.time_zone ?? ev.time_zone,
      color: v.color ?? ev.color,
      visibility: v.visibility ?? ev.visibility,
      reminders: v.reminders ?? ev.reminders,
      status: ev.status,
      rrule: null,
      exdates: [],
    })
    .select(EVENT_COLUMNS)
    .single();
  if (error || !copy) {
    return writeErrorResponse(error ?? {}, 'Failed to update event');
  }
  const copyId = (copy as unknown as { id: string }).id;
  const dropCopy = () =>
    supabase.from('calendar_events').delete().eq('id', copyId);

  if (attendees.length > 0) {
    const { error: attErr } = await supabase
      .from('calendar_event_attendees')
      .insert(
        attendees.map((user_id) => ({
          event_id: copyId,
          account_id: accountId,
          user_id,
          response: 'pending',
        }))
      );
    if (attErr) {
      await dropCopy();
      return calendarDbErrorResponse(attErr, 'Failed to invite people');
    }
  }

  const { data, error: exErr } = await appendExdate(supabase, ev, occStart);
  if (exErr || !data || data.length === 0) {
    await dropCopy();
    return exErr
      ? writeErrorResponse(exErr, 'Failed to update event')
      : noRowsResponse(supabase, ev);
  }
  return NextResponse.json({ event: copy });
}

/**
 * DELETE `?scope=this|all&occurrenceStart=ISO` → `{ ok: true }`. On a
 * series, scope 'this' excludes one occurrence; otherwise the row goes
 * (its attendees cascade).
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
      const { data, error: exErr } = await appendExdate(
        supabase,
        ev,
        occurrenceStart!
      );
      if (exErr) return writeErrorResponse(exErr, 'Failed to delete event');
      if (!data || data.length === 0) return noRowsResponse(supabase, ev);
      return NextResponse.json({ ok: true });
    }

    const { data, error: delErr } = await supabase
      .from('calendar_events')
      .delete()
      .eq('id', id)
      .select('id');
    if (delErr) return writeErrorResponse(delErr, 'Failed to delete event');
    if (!data || data.length === 0) return noRowsResponse(supabase, ev);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
