// ============================================================
// /api/calendar/events/[id] — read, change and delete one event
// (migration 108). Everything runs under the caller's RLS client: an
// event is edited by its creator only, and deleted by its creator, or by
// an owner or admin once the creator has left (278).
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
import { canEditSettings, type AccountRole } from '@/lib/auth/roles';
import {
  expandEvent,
  fromFloating,
  isOccurrence,
  ruleIncludesStart,
  rruleSanity,
  seriesEndAt,
  toFloating,
} from '@/lib/calendar/recurrence';
import {
  calendarDbErrorResponse,
  EVENT_COLUMNS,
  requireCalendarUser,
} from '@/lib/calendar/server';
import { shiftRule } from '@/lib/calendar/rrule-form';
import {
  expectedStamp,
  parseEventInput,
  RULE_MISSES_START,
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

/**
 * Whether the caller may delete the event or cancel one of its dates: its
 * creator, or an owner or admin when the database says the creator has
 * left and the event is not private (278). Only an admin asks it. An rpc
 * error, such as the function missing before 278, is a no.
 */
async function canDeleteEvent(
  supabase: Db,
  ev: EventRow,
  userId: string,
  role: AccountRole
): Promise<boolean> {
  if (ev.created_by === userId) return true;
  if (!canEditSettings(role)) return false;
  const { data, error } = await supabase.rpc('calendar_event_can_remove', {
    p_event: ev.id,
  });
  return !error && data === true;
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

const DAY_MS = 86_400_000;

const byParts = (rrule: string) =>
  rrule
    .split(';')
    .filter((p) => p.startsWith('BY'))
    .sort()
    .join(';');

const freqOf = (rrule: string) => /(?:^|;)FREQ=(\w+)/.exec(rrule)?.[1];
const stepOf = (rrule: string) =>
  Number(/(?:^|;)INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1);

/** The whole days the series' start moved by. */
const startMoved = (ev: EventRow, next: EventRow) =>
  dayOf(next.start_at, next.time_zone) - dayOf(ev.start_at, ev.time_zone);

/** The stored rule moved by the start's whole days (null: no rule is). */
function shiftedRule(ev: EventRow, rrule: string, days: number) {
  const date = new Date(dayOf(ev.start_at, ev.time_zone) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return shiftRule(rrule, days, { date, timeZone: ev.time_zone });
}

/**
 * The whole days the occurrences moved by with the series' start: the
 * start's own, or none when the series only starts at another date. A
 * drag moves them and says so itself (a 7-day one leaves a weekly rule
 * unchanged). An edit in the dialog does when the rule's days (BY*) moved
 * by the same days, or when the rule names none and takes its day from the
 * start; a rule of every second week also when its weeks became the others.
 */
function occurrencesMoved(ev: EventRow, next: EventRow, dragged: boolean) {
  const days = startMoved(ev, next);
  if (dragged || days === 0 || !ev.rrule || !next.rrule) return days;
  const before = byParts(ev.rrule);
  const after = byParts(next.rrule);
  if (before !== after) {
    const moved = shiftedRule(ev, ev.rrule, days);
    // The month's day follows the start by itself (BYMONTHDAY), over a
    // month's end too, where shiftRule refuses.
    const monthDay = /^BYMONTHDAY=\d+$/;
    const follows =
      moved === null
        ? monthDay.test(before) && monthDay.test(after)
        : byParts(moved) === after;
    return follows ? days : 0;
  }
  const step = stepOf(next.rrule);
  const freq = freqOf(next.rrule);
  if (before) {
    if (freq !== 'WEEKLY' || freqOf(ev.rrule) !== freq) return 0;
    if (stepOf(ev.rrule) !== step) return 0;
    // Weeks of the rule (WKST), and whole ones: of TU,TH the start may have
    // moved to the other day as well.
    const wkst = /(?:^|;)WKST=(\w+)/.exec(next.rrule)?.[1] ?? 'MO';
    const first = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].indexOf(wkst);
    // Day 0 (1 January 1970) is a Thursday.
    const weekOf = (e: EventRow) =>
      Math.floor((dayOf(e.start_at, e.time_zone) + 3 - first) / 7);
    const weeks = weekOf(next) - weekOf(ev);
    return weeks % step === 0 ? 0 : weeks * 7;
  }
  if (freq === 'DAILY') return days % step === 0 ? 0 : days;
  if (freq === 'WEEKLY') return days % (7 * step) === 0 ? 0 : days;
  return days;
}

/** A monthly rule's BY* that names one date a month. */
const ONE_A_MONTH = /^(BYMONTHDAY=[+-]?\d+|BYDAY=[+-]?\d+[A-Z]{2})?$/;

/**
 * For a monthly series that stays one: the months its dates moved by, or
 * null when they did not move, or not by months. No number of days says
 * it: "the second Tuesday" lies 5 days before the second Thursday in one
 * month and 2 after in another, and months differ in length. A date stays
 * in its month, unless the rule's months (INTERVAL) became others, or the
 * start only crossed a month's end (the 28th became the 2nd).
 */
function monthsMoved(ev: EventRow, next: EventRow, dragged: boolean) {
  if (!ev.rrule || !next.rrule) return null;
  if (freqOf(ev.rrule) !== 'MONTHLY') return null;
  if (freqOf(next.rrule) !== 'MONTHLY') return null;
  const step = stepOf(next.rrule);
  if (stepOf(ev.rrule) !== step) return null;
  const before = byParts(ev.rrule);
  const after = byParts(next.rrule);
  if (!ONE_A_MONTH.test(before) || !ONE_A_MONTH.test(after)) return null;
  const months =
    monthOf(toFloating(Date.parse(next.start_at), next.time_zone)) -
    monthOf(toFloating(Date.parse(ev.start_at), ev.time_zone));
  const days = startMoved(ev, next);
  const moved =
    dragged || months % step !== 0 || Math.abs(days) <= 14 ? months : 0;
  const sameDates = before === after && (before !== '' || days === 0);
  return sameDates && moved === 0 ? null : moved;
}

/** Months since 1970 of a wall-clock time, and the first of such a month. */
const monthOf = (floating: number) => {
  const d = new Date(floating);
  return (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth();
};
const firstOfMonth = (month: number) => Date.UTC(1970, month);

/**
 * The series' exdates after its start or rule changed, each an occurrence
 * at the new time of day in the new zone: on its own day ("Wednesday 2
 * December" stays that date when the series only starts later), moved by
 * whole days when every occurrence moved, or the date of its month in a
 * monthly rule that now names another (dropped when that month has none).
 */
function shiftExdates(ev: EventRow, next: EventRow, dragged: boolean) {
  const exdates = ev.exdates ?? [];
  const months = monthsMoved(ev, next, dragged);
  if (months !== null) {
    return exdates.flatMap((x) => {
      const at = Date.parse(x);
      // One the old rule did not name cancelled nothing.
      if (!isOccurrence(ev, at)) return [];
      const month = monthOf(toFloating(at, ev.time_zone)) + months;
      const from = fromFloating(firstOfMonth(month), next.time_zone);
      const to = fromFloating(firstOfMonth(month + 1), next.time_zone);
      const found = expandEvent(
        { ...next, exdates: [] },
        from,
        to
      ).occurrences.find((o) => o.start >= from);
      return found ? [new Date(found.start).toISOString()] : [];
    });
  }
  const delta =
    toFloating(Date.parse(next.start_at), next.time_zone) -
    toFloating(Date.parse(ev.start_at), ev.time_zone) -
    (startMoved(ev, next) - occurrencesMoved(ev, next, dragged)) * DAY_MS;
  return exdates.map((x) =>
    new Date(
      fromFloating(
        toFloating(Date.parse(x), ev.time_zone) + delta,
        next.time_zone
      )
    ).toISOString()
  );
}

/** The whole day of an instant on the zone's calendar. */
const dayOf = (iso: string, timeZone: string) =>
  Math.floor(toFloating(Date.parse(iso), timeZone) / DAY_MS);

/**
 * Whether the edit leaves a series whose rule does not name its start
 * date. Only an edit of the start date or of the rule is judged: a series
 * stored that way before the check existed keeps its other fields (and
 * its time of day) editable.
 */
function missesStart(ev: EventRow, next: EventRow): boolean {
  if (!next.rrule) return false;
  const moved =
    next.rrule !== ev.rrule ||
    dayOf(next.start_at, next.time_zone) !== dayOf(ev.start_at, ev.time_zone);
  return moved && !ruleIncludesStart(next.rrule, next);
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
 *  canEdit, canDelete }`; 404 when the caller cannot see it. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, userId, role } = await requireCalendarUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid event id', 400);

    const { event, error } = await loadEvent(supabase, id);
    if (error) return readErrorResponse(error);
    if (!event) return jsonError('Event not found', 404);

    const [{ data: attendees, error: attErr }, canDelete] = await Promise.all([
      supabase
        .from('calendar_event_attendees')
        .select('user_id, response, responded_at')
        .eq('event_id', id),
      canDeleteEvent(supabase, event, userId, role),
    ]);
    if (attErr) return readErrorResponse(attErr);

    return NextResponse.json({
      event,
      attendees: attendees ?? [],
      canEdit: event.created_by === userId,
      canDelete,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH `{ …event fields (partial), attendees?, scope?: 'this'|'all',
 * occurrenceStart?, moveSeries?, expectedUpdatedAt }` → `{ event }`.
 * `moveSeries` marks a drag of all events (see occurrencesMoved). On a series,
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
    const next: EventRow = {
      ...ev,
      start_at: v.start_at ?? ev.start_at,
      end_at: v.end_at ?? ev.end_at,
      all_day: v.all_day ?? ev.all_day,
      time_zone: v.time_zone ?? ev.time_zone,
      rrule: v.rrule !== undefined ? v.rrule : ev.rrule,
    };
    // "Move all events": every occurrence shifts with the first one.
    let dragged = (raw as { moveSeries?: unknown }).moveSeries === true;
    if (missesStart(ev, next)) {
      // A drag keeps the start and the rule as they stood to each other, so
      // it is no reason to refuse a series that already missed its start. A
      // tab from before `moveSeries` sends only what the rule moved to; the
      // dialog refuses such a start itself.
      const missed = !!ev.rrule && !ruleIncludesStart(ev.rrule, ev);
      dragged ||=
        missed &&
        next.rrule === shiftedRule(ev, ev.rrule!, startMoved(ev, next));
      if (!missed || !dragged) return jsonError(RULE_MISSES_START, 400);
    }
    if (v.start_at !== undefined || v.rrule !== undefined) {
      changes.series_end_at = seriesEndAt(next)?.toISOString() ?? null;
      const before = ev.rrule ? (ev.exdates ?? []) : [];
      const after = shiftExdates(ev, next, dragged);
      if (
        before.length > 0 &&
        (before.length !== after.length ||
          !before.every((x, i) => sameInstant(x, after[i])))
      ) {
        changes.exdates = after;
      }
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
 * otherwise the row goes (its attendees cascade). Who may: `canDelete`.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const { supabase, userId, role } = await requireCalendarUser();
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
    if (!(await canDeleteEvent(supabase, ev, userId, role))) {
      return jsonError(NOT_ORGANISER, 403);
    }

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
