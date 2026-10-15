import { QUIET_HOURS_EXEMPT } from './kinds';

/**
 * Quiet hours (push_preferences.quiet_start / quiet_end / time_zone).
 * Stored by migration 109 but applied here, where the clock at send
 * time is known.
 *
 * Inside the window nothing is delivered except the reminders
 * (QUIET_HOURS_EXEMPT), which are only worth anything on time. Every
 * other row is held, not dropped, until the window ends, and delivered
 * then if it will be under 12 hours old; one that would be older is
 * skipped now (a morning full of last night's pings helps nobody).
 * A window may cross midnight (22:00–07:00). Equal ends mean none.
 */
export const HOLD_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface QuietPrefs {
  quiet_start: string | null;
  quiet_end: string | null;
  time_zone: string | null;
}

export type QuietDecision =
  | { action: 'send' }
  | { action: 'hold'; until: Date }
  | { action: 'skip'; reason: string };

/** '22:00' or Postgres' '22:00:00' → seconds since midnight. */
export function parseClock(value: string | null): number | null {
  const m = value ? /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value) : null;
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Seconds since local midnight in `zone` (UTC when unknown). */
function localSecondOfDay(now: Date, zone: string | null): number {
  const timeZone = zone && isValidTimeZone(zone) ? zone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

export function decideQuietHours(input: {
  kind: string;
  createdAt: Date;
  prefs: QuietPrefs | null;
  now: Date;
}): QuietDecision {
  const { kind, createdAt, prefs, now } = input;
  if (!prefs || QUIET_HOURS_EXEMPT.includes(kind)) return { action: 'send' };
  const start = parseClock(prefs.quiet_start);
  const end = parseClock(prefs.quiet_end);
  if (start === null || end === null || start === end)
    return { action: 'send' };

  const t = localSecondOfDay(now, prefs.time_zone);
  const inside = start < end ? t >= start && t < end : t >= start || t < end;
  if (!inside) return { action: 'send' };

  // A day has 86,400 local seconds except across a DST change, where
  // the release lands an hour off: acceptable for a notification.
  const untilEnd = (end - t + 86_400) % 86_400;
  const until = new Date(now.getTime() + untilEnd * 1000);
  if (until.getTime() - createdAt.getTime() >= HOLD_MAX_AGE_MS) {
    return {
      action: 'skip',
      reason: 'quiet hours (older than 12 h when they end)',
    };
  }
  return { action: 'hold', until };
}
