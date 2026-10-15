// ============================================================
// Calendar event bodies (migration 108) — pure, no I/O.
//
// Turns a create or patch body into column values. Limits mirror
// 108's CHECKs so a bad body is a 400 here, not a constraint error.
// All-day dates (YYYY-MM-DD, end exclusive) become the instants of
// midnight in the event's zone; timed values must carry an offset.
// ============================================================

import { fromFloating, rruleError, rruleSanity } from './recurrence';

export const EVENT_COLORS = [
  'blue',
  'green',
  'red',
  'amber',
  'violet',
  'pink',
  'teal',
  'slate',
] as const;
export type EventColor = (typeof EVENT_COLORS)[number];

export const EVENT_VISIBILITIES = [
  'private',
  'attendees',
  'workspace',
] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const LOCATION_MAX = 300;
export const REMINDERS_MAX = 5;
export const REMINDER_MAX_MINUTES = 40320;
export const ATTENDEES_MAX = 100;
/** Years an event may start or end in. Keeps a series' first date near
 *  any window it is expanded over (rrule walks from it). */
export const YEAR_MIN = 1970;
export const YEAR_MAX = 2100;

export interface EventInput {
  title: string;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  time_zone: string;
  color: EventColor;
  visibility: EventVisibility;
  reminders: number[];
  rrule: string | null;
  /** Invitees (lowercase uuids, unique, never the creator). */
  attendees: string[];
  /** Patch only: one occurrence or the whole series. */
  scope: 'this' | 'all';
  /** ISO instant of the occurrence edited when scope = 'this'. */
  occurrenceStart: string;
}

export type ParseEventResult =
  { ok: true; value: Partial<EventInput> } | { ok: false; error: string };

export interface ParseEventOptions {
  /** A patch: only the keys present are checked and returned. */
  partial?: boolean;
  /** The organiser, who is never an attendee. */
  creatorId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMED =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TIME_KEYS = ['start', 'end', 'allDay', 'timeZone'] as const;

class Invalid extends Error {}
const fail = (msg: string): never => {
  throw new Invalid(msg);
};

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function text(v: unknown, name: string, max: number, required: boolean) {
  if (v === undefined || v === null) {
    return required ? fail(`${name} is required`) : null;
  }
  if (typeof v !== 'string') return fail(`${name} must be text`);
  const t = v.trim();
  if (!t) return required ? fail(`${name} is required`) : null;
  if (t.length > max) return fail(`${name} must be at most ${max} characters`);
  return t;
}

function oneOf<T extends string>(
  v: unknown,
  name: string,
  allowed: readonly T[]
): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    return fail(`Unknown ${name}`);
  }
  return v as T;
}

function isoInstant(v: unknown, name: string): number {
  if (typeof v !== 'string' || !TIMED.test(v)) {
    return fail(`${name} must be an ISO date-time with an offset`);
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return fail(`${name} is not a real date-time`);
  return ms;
}

/** Midnight of a YYYY-MM-DD date in the zone, as an instant. */
function dateInZone(v: unknown, name: string, timeZone: string): number {
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  if (!m) return fail(`${name} must be a date (YYYY-MM-DD)`);
  const floating = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const back = new Date(floating);
  if (
    back.getUTCFullYear() !== +m[1] ||
    back.getUTCMonth() !== +m[2] - 1 ||
    back.getUTCDate() !== +m[3]
  ) {
    return fail(`${name} is not a real date`);
  }
  return fromFloating(floating, timeZone);
}

function times(raw: Record<string, unknown>) {
  if (typeof raw.allDay !== 'boolean')
    return fail('allDay must be true or false');
  if (!isValidTimeZone(raw.timeZone)) return fail('Unknown time zone');
  const tz = raw.timeZone;
  const start = raw.allDay
    ? dateInZone(raw.start, 'start', tz)
    : isoInstant(raw.start, 'start');
  const end = raw.allDay
    ? dateInZone(raw.end, 'end', tz)
    : isoInstant(raw.end, 'end');
  for (const [v, name] of [
    [raw.start, 'start'],
    [raw.end, 'end'],
  ] as const) {
    const year = Number(String(v).slice(0, 4));
    if (year < YEAR_MIN || year > YEAR_MAX) {
      fail(`${name} must be between ${YEAR_MIN} and ${YEAR_MAX}`);
    }
  }
  if (end <= start) return fail('The event must end after it starts');
  return {
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString(),
    all_day: raw.allDay,
    time_zone: tz,
  };
}

function reminders(v: unknown): number[] {
  if (!Array.isArray(v)) return fail('reminders must be a list');
  const out = new Set<number>();
  for (const r of v) {
    if (!Number.isInteger(r) || r < 0 || r > REMINDER_MAX_MINUTES) {
      return fail(
        `A reminder is a whole number of minutes, 0 to ${REMINDER_MAX_MINUTES}`
      );
    }
    out.add(r);
  }
  if (out.size > REMINDERS_MAX) {
    return fail(`At most ${REMINDERS_MAX} reminders`);
  }
  return [...out].sort((a, b) => a - b);
}

function attendees(v: unknown, creatorId: string | undefined): string[] {
  if (!Array.isArray(v)) return fail('attendees must be a list');
  const creator = creatorId?.toLowerCase();
  const out = new Set<string>();
  for (const a of v) {
    if (typeof a !== 'string' || !UUID.test(a)) {
      return fail('An attendee is not a valid person id');
    }
    const id = a.toLowerCase();
    if (id !== creator) out.add(id);
  }
  if (out.size > ATTENDEES_MAX)
    return fail(`At most ${ATTENDEES_MAX} attendees`);
  return [...out];
}

function rrule(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return fail('rrule must be text');
  const body = v.trim();
  if (!body) return null;
  const err = rruleError(body);
  return err ? fail(err) : body;
}

/**
 * Checks a create body (`partial` false: title, start, end, allDay,
 * timeZone, color, visibility and reminders required) or a patch body
 * (only keys present). start, end, allDay and timeZone travel together:
 * a patch carrying one of them must carry all four. Unknown keys are
 * ignored.
 */
export function parseEventInput(
  raw: unknown,
  opts: ParseEventOptions = {}
): ParseEventResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Expected a JSON object' };
  }
  const body = raw as Record<string, unknown>;
  const partial = !!opts.partial;
  const has = (k: string) => !partial || body[k] !== undefined;
  const value: Partial<EventInput> = {};
  try {
    if (has('title')) value.title = text(body.title, 'title', TITLE_MAX, true)!;
    if (has('description')) {
      value.description = text(
        body.description,
        'description',
        DESCRIPTION_MAX,
        false
      );
    }
    if (has('location')) {
      value.location = text(body.location, 'location', LOCATION_MAX, false);
    }
    if (TIME_KEYS.some((k) => has(k))) {
      if (TIME_KEYS.some((k) => body[k] === undefined)) {
        fail('start, end, allDay and timeZone must be sent together');
      }
      Object.assign(value, times(body));
    }
    if (has('color')) value.color = oneOf(body.color, 'colour', EVENT_COLORS);
    if (has('visibility')) {
      value.visibility = oneOf(
        body.visibility,
        'visibility',
        EVENT_VISIBILITIES
      );
    }
    if (has('reminders')) value.reminders = reminders(body.reminders);
    if (body.rrule !== undefined || !partial) value.rrule = rrule(body.rrule);
    if (body.attendees !== undefined) {
      value.attendees = attendees(body.attendees, opts.creatorId);
    } else if (!partial) {
      value.attendees = [];
    }
    if (body.scope !== undefined) {
      value.scope = oneOf(body.scope, 'scope', ['this', 'all'] as const);
    }
    if (body.occurrenceStart !== undefined) {
      value.occurrenceStart = new Date(
        isoInstant(body.occurrenceStart, 'occurrenceStart')
      ).toISOString();
    }
    // Without times in the body (a patch of the rule alone) the caller
    // checks the rule against the stored start with rruleSanity.
    if (value.rrule && value.start_at) {
      const err = rruleSanity(value.rrule, value as Required<EventInput>);
      if (err) fail(err);
    }
    if (value.scope === 'this' && !value.occurrenceStart) {
      fail('occurrenceStart is required to change one occurrence');
    }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, value };
}
