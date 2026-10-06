// ============================================================
// Broadcast quiet hours (migration 053).
//
// A per-campaign "do not send between HH:MM and HH:MM" window in an
// IANA time zone, stored on `broadcasts.quiet_hours` as
// `{ start, end, tz }`. Two callers, one rule:
//
//   - the wizard: a "send now" that lands inside the window becomes a
//     schedule for the moment the window ends;
//   - the broadcast cron: a scheduled campaign that comes due inside
//     the window is pushed to the moment the window ends.
//
// Everything here is pure and takes `now` as an argument so it can be
// tested against fixed instants. Time-zone maths goes through
// `Intl.DateTimeFormat` rather than a library: the only question asked
// is "what is the wall-clock time in `tz` at this instant".
// ============================================================

export interface QuietHours {
  /** "HH:MM", 24h, local to `tz`. */
  start: string;
  /** "HH:MM". May be earlier than `start` — the window then spans midnight. */
  end: string;
  /** IANA zone, e.g. "Asia/Dubai". */
  tz: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validate an untrusted value (request body, jsonb column) into a
 * `QuietHours`, or null when it is absent or malformed. A window whose
 * start equals its end is meaningless and treated as "none".
 */
export function parseQuietHours(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const { start, end, tz } = raw as Record<string, unknown>;
  if (typeof start !== 'string' || !HHMM.test(start)) return null;
  if (typeof end !== 'string' || !HHMM.test(end)) return null;
  if (typeof tz !== 'string' || !isValidTimeZone(tz)) return null;
  if (start === end) return null;
  return { start, end, tz };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Wall-clock minutes since midnight in `tz` at instant `at`. */
export function localMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** True when `now` falls inside the window (start inclusive, end exclusive). */
export function isInQuietHours(now: Date, quiet: QuietHours): boolean {
  const local = localMinutes(now, quiet.tz);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start < end
    ? local >= start && local < end
    : local >= start || local < end; // spans midnight
}

/**
 * The earliest instant at or after `now` that is outside the window:
 * `now` itself when it already is, otherwise the next moment the
 * wall clock in `tz` reads `end`. Seconds are dropped so the result is
 * a clean minute.
 *
 * A DST transition between `now` and `end` shifts the wall clock by an
 * hour; the one correction pass below re-aligns to `end` in that case.
 */
export function nextAllowedSendTime(now: Date, quiet: QuietHours): Date {
  if (!isInQuietHours(now, quiet)) return now;
  const end = toMinutes(quiet.end);
  const local = localMinutes(now, quiet.tz);
  const wait = (end - local + 1440) % 1440 || 1440;
  const floored = new Date(now);
  floored.setUTCSeconds(0, 0);
  const candidate = new Date(floored.getTime() + wait * 60_000);
  const drift = localMinutes(candidate, quiet.tz) - end;
  if (drift === 0) return candidate;
  return new Date(candidate.getTime() - drift * 60_000);
}
