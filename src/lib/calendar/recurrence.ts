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

// rrule.js checks UNTIL (and the between() bounds) only on a matching
// date, so a rule that matches nothing more (FREQ=DAILY;BYMONTH=2;
// BYMONTHDAY=30) walks period by period to the year 9999: ~13 s for a
// daily rule. Nothing in its public API stops that walk, so each walk
// gets a period budget: every step of rrule's loop reads
// `options.interval` (twice in 2.8.1), and a read past the budget
// throws WalkLimit. The budget covers the walk from dtstart to the
// walk's end with the shortest period of the frequency, so it never
// cuts a date the walk was asked for; it only ends the search for one
// past the end. Pinned by recurrence.test.ts ("bounded walk").
const MIN_PERIOD_MS: Record<number, number> = {
  [RRule.YEARLY]: 365 * DAY_MS,
  [RRule.MONTHLY]: 28 * DAY_MS,
  [RRule.WEEKLY]: 7 * DAY_MS,
  [RRule.DAILY]: DAY_MS,
};
const READS_PER_STEP = 4;

class WalkLimit extends Error {}

/** An RRule on the floating clock that walks no further than `walkEnd`
 *  (floating ms): UNTIL clamped to it, and a step budget. */
function boundedRule(
  opts: Partial<Options>,
  dtstart: number,
  walkEnd: number
): RRule {
  const until =
    opts.until && opts.until.getTime() < walkEnd
      ? opts.until
      : new Date(walkEnd);
  const rule = new RRule(
    { ...opts, dtstart: new Date(dtstart), until, tzid: null },
    true
  );
  const { freq, interval } = rule.options;
  const steps =
    Math.ceil(
      Math.max(0, walkEnd - dtstart) /
        ((MIN_PERIOD_MS[freq] ?? DAY_MS) * Math.max(1, interval))
    ) + 2;
  const budget = steps * READS_PER_STEP + 16;
  let reads = 0;
  rule.options = new Proxy(rule.options, {
    get(target, key, receiver) {
      if (key === 'interval' && ++reads > budget) throw new WalkLimit();
      return Reflect.get(target, key, receiver);
    },
  });
  return rule;
}

/** rule.between, where hitting the walk budget is a normal end. */
function walk(
  rule: RRule,
  after: number,
  before: number,
  each: (floating: number) => boolean
): void {
  try {
    rule.between(new Date(after), new Date(before), true, (d) =>
      each(d.getTime())
    );
  } catch (err) {
    if (!(err instanceof WalkLimit)) throw err;
  }
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
  const lengthMs = occurrenceEnd(ev, startFloat) - Date.parse(ev.start_at);
  // Floating bounds, padded by a day either side (zone offsets) and by
  // the event's length (an occurrence that started before `from`).
  const after = toFloating(from, 'UTC') - lengthMs - 2 * DAY_MS;
  const before = to + 2 * DAY_MS;
  const rule = boundedRule(
    parseOptions(ev.rrule, ev.time_zone),
    startFloat,
    before
  );
  let truncated = false;
  walk(rule, after, before, (d) => {
    const start = fromFloating(d, ev.time_zone);
    if (excluded.has(start)) return true;
    const o = { start, end: occurrenceEnd(ev, d) };
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

/** Years a rule may take to produce its first date (rruleSanity). */
export const FIRST_OCCURRENCE_YEARS = 10;
/** How far seriesEndAt looks for a bounded series' last date. */
export const SERIES_END_HORIZON_YEARS = 100;

const addYears = (floatingMs: number, years: number) => {
  const d = new Date(floatingMs);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
};

type SeriesAnchor = Pick<
  ExpandableEvent,
  'start_at' | 'end_at' | 'all_day' | 'time_zone'
>;

/**
 * rruleError, plus: the rule must produce a date within
 * FIRST_OCCURRENCE_YEARS of the series' start. A rule that never
 * matches (30 February), or ends before it starts, is refused.
 */
export function rruleSanity(body: string, anchor: SeriesAnchor): string | null {
  const err = rruleError(body);
  if (err) return err;
  const startFloat = toFloating(Date.parse(anchor.start_at), anchor.time_zone);
  const horizon = addYears(startFloat, FIRST_OCCURRENCE_YEARS);
  const rule = boundedRule(
    parseOptions(body, anchor.time_zone),
    startFloat,
    horizon
  );
  let found = false;
  walk(rule, startFloat, horizon, () => {
    found = true;
    return false;
  });
  return found
    ? null
    : `Repeat rule has no date within ${FIRST_OCCURRENCE_YEARS} years of the start`;
}

/**
 * The end of a series' last occurrence when its rule is bounded by
 * COUNT or UNTIL, else null (open-ended, or a one-off event). exdates
 * are ignored, so the value depends only on the times and the rule; a
 * bounded series whose end lies beyond SERIES_END_HORIZON_YEARS is
 * null as well, which readers treat as "still running". A bounded rule
 * with no occurrence at all ends with its first slot (end_at).
 */
export function seriesEndAt(ev: ExpandableEvent): Date | null {
  if (!ev.rrule) return null;
  const opts = parseOptions(ev.rrule, ev.time_zone);
  const count = opts.count ?? null;
  const until = opts.until ? opts.until.getTime() : null;
  if (count === null && until === null) return null;
  const startFloat = toFloating(Date.parse(ev.start_at), ev.time_zone);
  const horizon = addYears(startFloat, SERIES_END_HORIZON_YEARS);
  if (count === null && until! > horizon) return null;
  const rule = boundedRule(opts, startFloat, horizon);
  let seen = 0;
  let last = null as number | null;
  walk(rule, startFloat, horizon, (d) => {
    seen++;
    last = d;
    return true;
  });
  if (count !== null && seen < count) return null;
  if (last === null) return new Date(Date.parse(ev.end_at));
  return new Date(occurrenceEnd(ev, last));
}

/** Whether `start` (ms) is one of the series' own occurrence starts. */
export function isOccurrence(ev: ExpandableEvent, start: number): boolean {
  return expandEvent({ ...ev, exdates: [] }, start, start + 1).occurrences.some(
    (o) => o.start === start
  );
}
