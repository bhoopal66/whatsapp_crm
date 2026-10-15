// ============================================================
// Calendar recurrence (migration 108) — pure, no I/O.
//
// A recurring event carries an RFC 5545 RRULE body and the IANA zone
// its creator picked. It is expanded on "floating" dates: the start's
// wall clock in that zone is fed to rrule as if it were UTC, and each
// result is turned back into an instant in the zone. So a weekly 09:00
// stays 09:00 local across a DST change (rrule's own tzid support is
// not used). exdates are cancelled occurrences, by original start.
// ============================================================

import { RRule, type Options } from 'rrule';

export const MAX_RANGE_DAYS = 400;
export const MAX_INSTANCES = 2000;
export const RRULE_MAX = 500;

const DAY_MS = 86_400_000;

interface Wall {
  y: number;
  mo: number; // 1..12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock of an instant in a zone. */
export function wallClock(instant: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    y: parts.year,
    mo: parts.month,
    d: parts.day,
    h: parts.hour === 24 ? 0 : parts.hour,
    mi: parts.minute,
    s: parts.second,
  };
}

/** A wall clock as a fake-UTC millisecond count (the floating form). */
const floating = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** The instant's floating (wall-clock-as-UTC) form in the zone. */
export function toFloating(instant: number, timeZone: string): number {
  return floating(wallClock(instant, timeZone)) + (instant % 1000);
}

/** The instant whose wall clock in the zone is the floating time. A
 *  time inside a spring-forward gap lands an hour later. */
export function fromFloating(floatingMs: number, timeZone: string): number {
  const offsetAt = (t: number) => toFloating(t, timeZone) - t;
  const first = floatingMs - offsetAt(floatingMs);
  const second = floatingMs - offsetAt(first);
  return second === first ? first : Math.max(first, second);
}

const RRULE_KEYS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
]);
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** Why an RRULE body is refused, or null when it is usable. Mirrors
 *  108's CHECK (≤ 500, starts FREQ=, no spaces) plus what we expand. */
export function rruleError(body: string): string | null {
  if (body.length > RRULE_MAX || !/^FREQ=\S+$/.test(body)) {
    return `Repeat rule must start with FREQ= and be at most ${RRULE_MAX} characters`;
  }
  const seen = new Set<string>();
  for (const part of body.split(';')) {
    const [key, value] = part.split('=');
    if (!RRULE_KEYS.has(key) || !value || seen.has(key)) {
      return `Unsupported repeat rule part: ${part}`;
    }
    seen.add(key);
  }
  const freq = /^FREQ=([A-Z]+)/.exec(body)?.[1] ?? '';
  if (!FREQS.has(freq))
    return 'Repeat must be daily, weekly, monthly or yearly';
  if (seen.has('COUNT') && seen.has('UNTIL')) {
    return 'A repeat rule ends on a date or after a count, not both';
  }
  try {
    parseOptions(body, 'UTC');
  } catch {
    return 'Repeat rule could not be read';
  }
  return null;
}

/** rrule options on the floating clock. UNTIL with Z is an instant (so
 *  converted to the zone's wall clock); a date-only UNTIL is that whole
 *  day, a zoneless one is already wall clock. */
function parseOptions(body: string, timeZone: string): Partial<Options> {
  const opts = RRule.parseString(body);
  const until = /(?:^|;)UNTIL=(\d{8})(T\d{6}Z?)?(?:;|$)/.exec(body);
  if (until) {
    const [, date, time] = until;
    const ymd = [+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)];
    if (!time) {
      opts.until = new Date(Date.UTC(ymd[0], ymd[1], ymd[2], 23, 59, 59));
    } else {
      const t = time.slice(1);
      const ms = Date.UTC(
        ymd[0],
        ymd[1],
        ymd[2],
        +t.slice(0, 2),
        +t.slice(2, 4),
        +t.slice(4, 6)
      );
      opts.until = new Date(t.endsWith('Z') ? toFloating(ms, timeZone) : ms);
    }
  }
  if (opts.count !== undefined && opts.count !== null && !(opts.count >= 1)) {
    throw new Error('bad count');
  }
  return opts;
}

export interface ExpandableEvent {
  start_at: string;
  end_at: string;
  all_day: boolean;
  time_zone: string;
  rrule: string | null;
  exdates?: readonly string[] | null;
}

export interface Occurrence {
  /** The occurrence's original start: its identity (exdates, reminders). */
  start: number;
  end: number;
}

export interface Expansion {
  occurrences: Occurrence[];
  /** True when MAX_INSTANCES cut the list short. */
  truncated: boolean;
}

/** End of an occurrence: the series' wall-clock length added to its
 *  wall-clock start (an all-day day is a day, 23 h or 25 h). A one-day
 *  all-day event may be stored with end = start. */
function occurrenceEnd(ev: ExpandableEvent, startFloating: number): number {
  const s = Date.parse(ev.start_at);
  const e = Date.parse(ev.end_at);
  let length = toFloating(e, ev.time_zone) - toFloating(s, ev.time_zone);
  if (ev.all_day && length <= 0) length = DAY_MS;
  return fromFloating(startFloating + length, ev.time_zone);
}

/**
 * The event's occurrences overlapping [from, to) (instants, ms), in
 * order, without exdates, at most MAX_INSTANCES. A one-off event is its
 * own single occurrence.
 */
export function expandEvent(
  ev: ExpandableEvent,
  from: number,
  to: number
): Expansion {
  const out: Occurrence[] = [];
  const startFloat = toFloating(Date.parse(ev.start_at), ev.time_zone);
  const overlaps = (o: Occurrence) =>
    o.start < to && (o.end > from || (o.end === o.start && o.start >= from));
  if (!ev.rrule) {
    const o = {
      start: Date.parse(ev.start_at),
      end: occurrenceEnd(ev, startFloat),
    };
    return { occurrences: overlaps(o) ? [o] : [], truncated: false };
  }
  const excluded = new Set((ev.exdates ?? []).map((x) => Date.parse(x)));
  const rule = new RRule({
    ...parseOptions(ev.rrule, ev.time_zone),
    dtstart: new Date(startFloat),
    tzid: null,
  });
  const lengthMs = occurrenceEnd(ev, startFloat) - Date.parse(ev.start_at);
  // Floating bounds, padded by a day either side (zone offsets) and by
  // the event's length (an occurrence that started before `from`).
  const after = new Date(toFloating(from, 'UTC') - lengthMs - 2 * DAY_MS);
  const before = new Date(to + 2 * DAY_MS);
  let truncated = false;
  rule.between(after, before, true, (d) => {
    const start = fromFloating(d.getTime(), ev.time_zone);
    if (excluded.has(start)) return true;
    const o = { start, end: occurrenceEnd(ev, d.getTime()) };
    if (start >= to) return false;
    if (!overlaps(o)) return true;
    if (out.length >= MAX_INSTANCES) {
      truncated = true;
      return false;
    }
    out.push(o);
    return true;
  });
  return { occurrences: out, truncated };
}

/** Whether `start` (ms) is one of the series' own occurrence starts. */
export function isOccurrence(ev: ExpandableEvent, start: number): boolean {
  return expandEvent({ ...ev, exdates: [] }, start, start + 1).occurrences.some(
    (o) => o.start === start
  );
}
