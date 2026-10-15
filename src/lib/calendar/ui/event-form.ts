// ============================================================
// The create/edit dialog's state <-> the calendar API body — pure.
//
// Dates and times in the form are wall-clock values in the event's own
// zone. An all-day event's end date is shown inclusive (a one-day event
// ends the day it starts) while the API, like FullCalendar, takes it
// exclusive, so the conversion adds and removes that day here and
// nowhere else. Turning an instant into a date always goes through the
// zone: UTC midnight is a different day for half the world.
// ============================================================

import { zonedParts, zonedWallTimeToInstant } from '@/lib/meetings/schedule';

import {
  defaultRepeatForm,
  formToRrule,
  rruleToForm,
  type RepeatAnchor,
  type RepeatForm,
} from '../rrule-form';
import {
  DESCRIPTION_MAX,
  LOCATION_MAX,
  REMINDERS_MAX,
  TITLE_MAX,
  type EventColor,
  type EventVisibility,
} from '../validate';
import { addDaysToKey } from './mini-month';

export interface EventFormValues {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** YYYY-MM-DD in `timeZone`. */
  startDate: string;
  /** HH:MM in `timeZone` (ignored when all-day). */
  startTime: string;
  /** YYYY-MM-DD; inclusive when all-day. */
  endDate: string;
  endTime: string;
  timeZone: string;
  repeat: RepeatForm;
  /** A rule the picker cannot show, kept as-is until the picker is used. */
  customRrule: string | null;
  attendees: string[];
  color: EventColor;
  visibility: EventVisibility;
  reminders: number[];
}

/** The `calendar_events` columns the dialog reads. */
export interface EventRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  time_zone: string;
  color: EventColor;
  rrule: string | null;
  visibility: EventVisibility;
  reminders: number[] | null;
  created_by: string;
}

export type FormField =
  | 'title'
  | 'start'
  | 'end'
  | 'description'
  | 'location'
  | 'repeat'
  | 'reminders';

/** Keys under `Calendar.form.errors`. */
export type FormErrorKey =
  | 'titleRequired'
  | 'titleTooLong'
  | 'invalidStart'
  | 'invalidEnd'
  | 'endBeforeStart'
  | 'descriptionTooLong'
  | 'locationTooLong'
  | 'repeatInvalid'
  | 'tooManyReminders';

export type FormErrors = Partial<Record<FormField, FormErrorKey>>;

export const DEFAULT_REMINDERS = [10];
const HOUR_MS = 3_600_000;

/** The wall-clock date of an instant in a zone. */
export function dateKeyInZone(ms: number, zone: string): string {
  return zonedParts(new Date(ms).toISOString(), zone).date;
}

function wallParts(ms: number, zone: string) {
  return zonedParts(new Date(ms).toISOString(), zone);
}

function anchorOf(v: Pick<EventFormValues, 'startDate' | 'timeZone'>) {
  return { date: v.startDate, timeZone: v.timeZone } satisfies RepeatAnchor;
}

function base(
  zone: string,
  start: number,
  end: number,
  allDay: boolean
): EventFormValues {
  // Dates go through the zone (dateKeyInZone), never UTC midnight.
  const s = { ...wallParts(start, zone), date: dateKeyInZone(start, zone) };
  const e = { ...wallParts(end, zone), date: dateKeyInZone(end, zone) };
  return {
    title: '',
    description: '',
    location: '',
    allDay,
    startDate: s.date,
    startTime: allDay ? '09:00' : s.time,
    endDate: allDay ? addDaysToKey(e.date, -1) : e.date,
    endTime: allDay ? '10:00' : e.time,
    timeZone: zone,
    repeat: defaultRepeatForm({ date: s.date, timeZone: zone }),
    customRrule: null,
    attendees: [],
    color: 'blue',
    visibility: 'attendees',
    reminders: [...DEFAULT_REMINDERS],
  };
}

/** A new event: the next half hour, one hour long. */
export function defaultEventForm(now: Date, zone: string): EventFormValues {
  const step = 30 * 60_000;
  const start = Math.ceil((now.getTime() + 1) / step) * step;
  return base(zone, start, start + HOUR_MS, false);
}

/** A new event from a drag-select (FullCalendar instants, end exclusive). */
export function formFromSelection(
  start: Date,
  end: Date,
  allDay: boolean,
  zone: string
): EventFormValues {
  const s = start.getTime();
  const e = Math.max(end.getTime(), s + (allDay ? 0 : 30 * 60_000));
  // An all-day selection of zero days still means one day.
  if (allDay && dateKeyInZone(e, zone) === dateKeyInZone(s, zone)) {
    return base(zone, s, s + 24 * HOUR_MS + HOUR_MS, true);
  }
  return base(zone, s, e, allDay);
}

/**
 * An existing event's values. `occurrence` (instants or, all-day, dates
 * as the feed gives them) edits one occurrence of a series: its own
 * times, and no repeat.
 */
export function formFromEvent(
  ev: EventRow,
  attendeeIds: readonly string[],
  occurrence?: { start: string; end: string }
): EventFormValues {
  const zone = ev.time_zone;
  let startMs = Date.parse(ev.start_at);
  let endMs = Date.parse(ev.end_at);
  if (occurrence) {
    if (ev.all_day) {
      startMs = zonedWallTimeToInstant(
        occurrence.start,
        '00:00',
        zone
      )!.getTime();
      endMs = zonedWallTimeToInstant(occurrence.end, '00:00', zone)!.getTime();
    } else {
      startMs = Date.parse(occurrence.start);
      endMs = Date.parse(occurrence.end);
    }
  }
  const v = base(zone, startMs, endMs, ev.all_day);
  const repeat = occurrence ? null : rruleToForm(ev.rrule, anchorOf(v));
  return {
    ...v,
    title: ev.title,
    description: ev.description ?? '',
    location: ev.location ?? '',
    repeat: repeat ?? v.repeat,
    customRrule: !occurrence && ev.rrule && !repeat ? ev.rrule : null,
    attendees: attendeeIds.filter((id) => id !== ev.created_by),
    color: ev.color,
    visibility: ev.visibility,
    reminders: [...(ev.reminders ?? [])],
  };
}

/** Switch all-day on or off, keeping the dates. */
export function withAllDay(
  v: EventFormValues,
  allDay: boolean
): EventFormValues {
  if (v.allDay === allDay) return v;
  if (allDay) return { ...v, allDay };
  // A timed event on the last day: same day, an hour long.
  return {
    ...v,
    allDay,
    endDate: v.startDate,
    startTime: v.startTime || '09:00',
    endTime: v.endTime > v.startTime ? v.endTime : v.startTime,
  };
}

/**
 * Move the start, keeping the length (as calendars do when the start
 * changes), in the form's own zone.
 */
export function withStart(
  v: EventFormValues,
  startDate: string,
  startTime: string
): EventFormValues {
  const span = spanOf(v);
  const next = { ...v, startDate, startTime };
  if (span === null) return next;
  if (v.allDay) {
    return { ...next, endDate: addDaysToKey(startDate, span.days) };
  }
  const s = zonedWallTimeToInstant(startDate, startTime, v.timeZone);
  if (!s) return next;
  const e = wallParts(s.getTime() + span.ms, v.timeZone);
  return { ...next, endDate: e.date, endTime: e.time };
}

function spanOf(v: EventFormValues): { days: number; ms: number } | null {
  if (v.allDay) {
    const a = Date.parse(`${v.startDate}T00:00:00Z`);
    const b = Date.parse(`${v.endDate}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return { days: Math.max(0, Math.round((b - a) / 86_400_000)), ms: 0 };
  }
  const s = zonedWallTimeToInstant(v.startDate, v.startTime, v.timeZone);
  const e = zonedWallTimeToInstant(v.endDate, v.endTime, v.timeZone);
  if (!s || !e) return null;
  return { days: 0, ms: Math.max(0, e.getTime() - s.getTime()) };
}

/** The repeat rule the form saves: the picker's, or the custom one kept. */
export function formRrule(v: EventFormValues): string | null {
  if (v.customRrule !== null) return v.customRrule;
  return formToRrule(v.repeat, anchorOf(v));
}

export interface TimeFields {
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
}

export type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; errors: FormErrors };

function timeFields(v: EventFormValues, errors: FormErrors): TimeFields | null {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (v.allDay) {
    if (!DATE.test(v.startDate)) errors.start = 'invalidStart';
    if (!DATE.test(v.endDate)) errors.end = 'invalidEnd';
    if (errors.start || errors.end) return null;
    if (v.endDate < v.startDate) {
      errors.end = 'endBeforeStart';
      return null;
    }
    return {
      start: v.startDate,
      end: addDaysToKey(v.endDate, 1),
      allDay: true,
      timeZone: v.timeZone,
    };
  }
  const s = zonedWallTimeToInstant(v.startDate, v.startTime, v.timeZone);
  const e = zonedWallTimeToInstant(v.endDate, v.endTime, v.timeZone);
  if (!s) errors.start = 'invalidStart';
  if (!e) errors.end = 'invalidEnd';
  if (!s || !e) return null;
  if (e.getTime() <= s.getTime()) {
    errors.end = 'endBeforeStart';
    return null;
  }
  return {
    start: s.toISOString(),
    end: e.toISOString(),
    allDay: false,
    timeZone: v.timeZone,
  };
}

/** Every field checked; the full body a POST takes. */
function fullBody(v: EventFormValues, withRepeat: boolean): BodyResult {
  const errors: FormErrors = {};
  const title = v.title.trim();
  if (!title) errors.title = 'titleRequired';
  else if (title.length > TITLE_MAX) errors.title = 'titleTooLong';
  if (v.description.length > DESCRIPTION_MAX) {
    errors.description = 'descriptionTooLong';
  }
  if (v.location.trim().length > LOCATION_MAX) {
    errors.location = 'locationTooLong';
  }
  if (v.reminders.length > REMINDERS_MAX) errors.reminders = 'tooManyReminders';
  const time = timeFields(v, errors);
  let rrule: string | null = null;
  if (withRepeat) {
    try {
      rrule = formRrule(v);
    } catch {
      errors.repeat = 'repeatInvalid';
    }
  }
  if (Object.keys(errors).length > 0 || !time) return { ok: false, errors };
  return {
    ok: true,
    body: {
      title,
      description: v.description.trim() || null,
      location: v.location.trim() || null,
      ...time,
      color: v.color,
      visibility: v.visibility,
      reminders: [...v.reminders].sort((a, b) => a - b),
      ...(withRepeat ? { rrule } : {}),
      attendees: v.attendees,
    },
  };
}

/** POST /api/calendar/events. */
export function createBody(v: EventFormValues): BodyResult {
  return fullBody(v, true);
}

export interface EditTarget {
  original: EventFormValues;
  /** 'this' edits one occurrence of a series (no repeat), else the row. */
  scope: 'this' | 'all';
  occurrenceStart?: string;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * PATCH /api/calendar/events/[id]: only what changed (the time fields
 * travel together), so a save never rewrites what someone else just
 * changed in a field this person did not touch. An empty body means
 * there is nothing to save.
 */
export function editBody(v: EventFormValues, target: EditTarget): BodyResult {
  const series = target.scope === 'all';
  const next = fullBody(v, series);
  if (!next.ok) return next;
  const prev = fullBody(target.original, series);
  const body: Record<string, unknown> = {};
  const before = prev.ok ? prev.body : {};
  const timeKeys = ['start', 'end', 'allDay', 'timeZone'];
  if (timeKeys.some((k) => !same(next.body[k], before[k]))) {
    for (const k of timeKeys) body[k] = next.body[k];
  }
  for (const [k, value] of Object.entries(next.body)) {
    if (timeKeys.includes(k)) continue;
    if (!same(value, before[k])) body[k] = value;
  }
  if (Object.keys(body).length === 0) return { ok: true, body };
  if (target.scope === 'this' && target.occurrenceStart) {
    body.scope = 'this';
    body.occurrenceStart = target.occurrenceStart;
  } else {
    body.scope = 'all';
  }
  return { ok: true, body };
}
