// ============================================================
// Response times (migration 237): business hours and business
// minutes, pure. The SQL is the authority (`response_business_minutes`,
// `response_hours_valid`, `response_default_hours`); this mirrors it so
// the UI can show "waiting 2 h 10 min" and validate the settings form
// without a round trip. Change one, change both: hours.test.ts reads
// the migration for the defaults and runs the same vectors as
// supabase/ci/verify-response-targets.sql.
// ============================================================

import { zoneOffsetMs } from '@/lib/team-activity/range';

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** One open interval of a day, "HH:MM" to "HH:MM" (end may be "24:00"). */
export type HoursInterval = [string, string];
/** A missing day is closed. */
export type BusinessHours = Partial<Record<Weekday, HoursInterval[]>>;

export const MAX_INTERVALS_PER_DAY = 4;
export const DEFAULT_TIMEZONE = 'Asia/Dubai';
export const DEFAULT_TARGET_MINUTES = 15;
export const MIN_TARGET_MINUTES = 1;
export const MAX_TARGET_MINUTES = 1440;
/** The SQL scans at most this many days back from the end (a lower bound past it). */
export const SCAN_CAP_DAYS = 62;

/** Monday to Saturday 09:00-18:00, Sunday off (237's response_default_hours). */
export const DEFAULT_RESPONSE_HOURS: Readonly<
  Record<Weekday, HoursInterval[]>
> = {
  mon: [['09:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '18:00']],
  sat: [['09:00', '18:00']],
  sun: [],
};

export interface ResponseSettings {
  enabled: boolean;
  timezone: string;
  hours: Record<Weekday, HoursInterval[]>;
  targetMinutes: number;
}

export const DEFAULT_RESPONSE_SETTINGS: ResponseSettings = {
  enabled: false,
  timezone: DEFAULT_TIMEZONE,
  hours: copyHours(DEFAULT_RESPONSE_HOURS),
  targetMinutes: DEFAULT_TARGET_MINUTES,
};

function copyHours(
  h: Readonly<Partial<Record<Weekday, HoursInterval[]>>>
): Record<Weekday, HoursInterval[]> {
  const out = {} as Record<Weekday, HoursInterval[]>;
  for (const d of WEEKDAYS) {
    out[d] = (h[d] ?? []).map(([s, e]) => [s, e] as HoursInterval);
  }
  return out;
}

const START_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function isEnd(v: string): boolean {
  return v === '24:00' || START_RE.test(v);
}

/** The same rule as SQL's response_hours_valid. */
export function validateHours(value: unknown): value is BusinessHours {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, day] of Object.entries(value as Record<string, unknown>)) {
    if (!(WEEKDAYS as readonly string[]).includes(key)) return false;
    if (!Array.isArray(day) || day.length > MAX_INTERVALS_PER_DAY) return false;
    let prev: string | null = null;
    for (const iv of day) {
      if (!Array.isArray(iv) || iv.length !== 2) return false;
      const [s, e] = iv as unknown[];
      if (typeof s !== 'string' || typeof e !== 'string') return false;
      if (!START_RE.test(s) || !isEnd(e) || s >= e) return false;
      if (prev !== null && s < prev) return false;
      prev = e;
    }
  }
  return true;
}

/** Defensive parse of a response_settings row (or the API's answer). */
export function parseResponseSettings(value: unknown): ResponseSettings {
  if (!value || typeof value !== 'object') {
    return {
      ...DEFAULT_RESPONSE_SETTINGS,
      hours: copyHours(DEFAULT_RESPONSE_HOURS),
    };
  }
  const v = value as Record<string, unknown>;
  const target = v.target_minutes ?? v.targetMinutes;
  return {
    enabled: v.enabled === true,
    timezone:
      typeof v.timezone === 'string' && v.timezone
        ? v.timezone
        : DEFAULT_TIMEZONE,
    hours: validateHours(v.hours)
      ? copyHours(v.hours)
      : copyHours(DEFAULT_RESPONSE_HOURS),
    targetMinutes:
      typeof target === 'number' &&
      Number.isInteger(target) &&
      target >= MIN_TARGET_MINUTES &&
      target <= MAX_TARGET_MINUTES
        ? target
        : DEFAULT_TARGET_MINUTES,
  };
}

const DAY_MS = 86_400_000;

/** The local calendar date (as a UTC-midnight epoch) of `instant` in `tz`. */
function localDay(instant: number, tz: string): number {
  const local = instant + zoneOffsetMs(instant, tz);
  return Math.floor(local / DAY_MS) * DAY_MS;
}

/** The instant of local wall time `wallMs` (a UTC-based epoch) in `tz`. */
function wallToInstant(wallMs: number, tz: string): number {
  const guess = wallMs - zoneOffsetMs(wallMs, tz);
  return wallMs - zoneOffsetMs(guess, tz);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Whole business minutes between two instants (ms), as SQL's
 * response_business_minutes: each weekday's intervals laid on the local
 * calendar of `timezone`, the scan capped at the last 62 days.
 */
export function businessMinutesBetween(
  from: number,
  to: number,
  hours: BusinessHours = DEFAULT_RESPONSE_HOURS,
  timezone: string = DEFAULT_TIMEZONE
): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const start = Math.max(from, to - SCAN_CAP_DAYS * DAY_MS);
  let ms = 0;
  const last = localDay(to, timezone);
  for (let day = localDay(start, timezone); day <= last; day += DAY_MS) {
    // 1970-01-01 was a Thursday: index 3 in mon..sun.
    const key = WEEKDAYS[(Math.floor(day / DAY_MS) + 3) % 7]!;
    for (const [s, e] of hours[key] ?? []) {
      const ivStart = wallToInstant(day + minutesOf(s) * 60_000, timezone);
      const ivEnd = wallToInstant(day + minutesOf(e) * 60_000, timezone);
      ms += Math.max(0, Math.min(ivEnd, to) - Math.max(ivStart, start));
    }
  }
  return Math.floor(ms / 60_000);
}

/** Split minutes for display ("2 h 10 min"): the caller words it. */
export function splitMinutes(minutes: number): {
  hours: number;
  minutes: number;
} {
  const m = Math.max(0, Math.floor(minutes));
  return { hours: Math.floor(m / 60), minutes: m % 60 };
}

/**
 * A time input cannot show "24:00": an end of midnight shows as "00:00",
 * and "00:00" typed as an end means midnight ("24:00").
 */
export function endToInput(end: string): string {
  return end === '24:00' ? '00:00' : end;
}

export function endFromInput(value: string): string {
  return value === '00:00' ? '24:00' : value;
}

/** A new interval for a day: after its last one, else 09:00-18:00. */
export function nextInterval(
  day: readonly HoursInterval[]
): HoursInterval | null {
  if (day.length >= MAX_INTERVALS_PER_DAY) return null;
  const last = day[day.length - 1];
  if (!last) return ['09:00', '18:00'];
  const start = last[1];
  if (start === '24:00' || start >= '23:00') return null;
  const h = Number(start.slice(0, 2)) + 1;
  return [start, `${String(h).padStart(2, '0')}${start.slice(2)}`];
}

/** Whether a wait of `minutes` business minutes is past the target / twice it. */
export function waitLevel(
  minutes: number,
  targetMinutes: number
): 'ok' | 'target' | 'escalated' {
  if (minutes >= 2 * targetMinutes) return 'escalated';
  if (minutes >= targetMinutes) return 'target';
  return 'ok';
}
