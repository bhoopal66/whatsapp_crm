// The schedule of a time-based automation: a 5-field cron expression
// (minute hour day-of-month month day-of-week), read in a time zone, or a
// legacy plain "HH:mm" (every day at that time). Pure: no clock, no I/O;
// the runner (`time-based.ts`) passes `now` in.
//
// Supported per field: `*`, a number, `a-b`, lists `a,b`, steps `*/n` and
// `a-b/n`. Day of week is 0-7 with 0 and 7 both Sunday. As in classic
// cron, when both day fields are restricted a day matches either.

import { parseClock } from '@/lib/time-of-day';

interface Field {
  /** Allowed values. */
  values: Set<number>;
  /** The field was `*` (or `*` with a step of 1). */
  any: boolean;
}

export interface CronSchedule {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

const RANGES: readonly [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 = Sunday)
];

function parseField(src: string, [lo, hi]: [number, number]): Field | null {
  const values = new Set<number>();
  let any = false;
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (m[1] === '*') {
      from = lo;
      to = hi;
      if (step === 1) any = true;
    } else {
      const [a, b] = m[1].split('-').map(Number);
      from = a;
      // "5/15" means from 5 to the end, every 15.
      to = b ?? (m[2] === undefined ? a : hi);
    }
    if (from < lo || to > hi || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values.size > 0 ? { values, any } : null;
}

/**
 * Parses a stored schedule; null when it is not one this runner reads
 * (the builder refuses to save it, and an old row never runs).
 */
export function parseCron(
  expr: string | null | undefined
): CronSchedule | null {
  const raw = (expr ?? '').trim();
  const clock = parseClock(raw);
  if (clock) {
    return parseCron(`${clock.minute} ${clock.hour} * * *`);
  }
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((f, i) => parseField(f, RANGES[i]));
  if (parsed.some((f) => f === null)) return null;
  const [minute, hour, dom, month, dow] = parsed as Field[];
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dom, month, dow };
}

export interface LocalMinute {
  minute: number;
  hour: number;
  /** 1-31 */
  day: number;
  /** 1-12 */
  month: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The wall clock in `tz` at `at`. An unknown zone throws (Intl). */
export function localMinuteOf(at: Date, tz: string): LocalMinute {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    day: Number(get('day')),
    month: Number(get('month')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Whether the schedule fires at this local minute. */
export function cronMatches(s: CronSchedule, t: LocalMinute): boolean {
  if (!s.minute.values.has(t.minute)) return false;
  if (!s.hour.values.has(t.hour)) return false;
  if (!s.month.values.has(t.month)) return false;
  const domOk = s.dom.values.has(t.day);
  const dowOk = s.dow.values.has(t.weekday);
  if (s.dom.any && s.dow.any) return true;
  if (s.dom.any) return dowOk;
  if (s.dow.any) return domOk;
  return domOk || dowOk;
}

/**
 * The scheduled minute to run now, or null: the latest minute in
 * (`now` - `lookbackMinutes`, `now`] at which the schedule fires in `tz`,
 * and not before `notBefore` (the automation's last save, so switching
 * one on at 09:05 does not run its 09:00 slot). A cron that is pinged
 * every few minutes still catches its slot; the ledger makes it once.
 */
export function dueSlot(
  schedule: CronSchedule,
  tz: string,
  now: Date,
  lookbackMinutes: number,
  notBefore?: Date | null
): Date | null {
  const floor = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let i = 0; i < lookbackMinutes; i++) {
    const at = new Date(floor - i * 60_000);
    if (notBefore && at.getTime() < notBefore.getTime()) return null;
    if (cronMatches(schedule, localMinuteOf(at, tz))) return at;
  }
  return null;
}

/** Whether `tz` is a time zone this runtime knows. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
