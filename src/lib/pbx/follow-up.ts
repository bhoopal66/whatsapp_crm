// The in-call window's follow-up reminder: when each preset is due.
// Times are the browser's local time, as the agent reads the clock on
// their wall; the task stores the instant (`toISOString()`), so
// whoever opens it later sees it in their own zone.

export const FOLLOW_UP_PRESETS = [
  'in1h',
  'in3h',
  'tomorrow10',
  'in2days10',
] as const;
export type FollowUpPreset = (typeof FOLLOW_UP_PRESETS)[number];

const HOUR_MS = 60 * 60_000;

/** `days` from today's local date at hh:00 local. */
function atLocal(now: Date, days: number, hour: number): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + days,
    hour,
    0,
    0,
    0
  );
}

/**
 * When a preset falls due, counted from `now`. A clock-time preset
 * that is not after `now` (it cannot be today, but a DST gap can move
 * a local 10:00) rolls forward a day at a time, so the reminder is
 * never set in the past.
 */
export function followUpDueAt(preset: FollowUpPreset, now: Date): Date {
  switch (preset) {
    case 'in1h':
      return new Date(now.getTime() + HOUR_MS);
    case 'in3h':
      return new Date(now.getTime() + 3 * HOUR_MS);
    case 'tomorrow10':
    case 'in2days10': {
      let days = preset === 'tomorrow10' ? 1 : 2;
      let due = atLocal(now, days, 10);
      while (due.getTime() <= now.getTime()) due = atLocal(now, ++days, 10);
      return due;
    }
    default: {
      const never: never = preset;
      throw new Error(`Unknown follow-up preset: ${String(never)}`);
    }
  }
}

export type CustomDueAt =
  { ok: true; at: Date } | { ok: false; reason: 'invalid' | 'past' };

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A `datetime-local` value ("2026-10-28T15:30", local time) as an
 * instant. It must name a real minute (no 31 February) and be after
 * `now`.
 */
export function parseCustomDueAt(value: string, now: Date): CustomDueAt {
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m) return { ok: false, reason: 'invalid' };
  const [y, mo, d, h, mi, s] = m.slice(1).map((p) => Number(p ?? 0));
  const at = new Date(y, mo - 1, d, h, mi, s, 0);
  if (
    Number.isNaN(at.getTime()) ||
    at.getFullYear() !== y ||
    at.getMonth() !== mo - 1 ||
    at.getDate() !== d
  )
    return { ok: false, reason: 'invalid' };
  if (at.getTime() <= now.getTime()) return { ok: false, reason: 'past' };
  return { ok: true, at };
}

/** A local instant as a `datetime-local` value, to the minute. */
export function toDateTimeLocal(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(
    at.getHours()
  )}:${p(at.getMinutes())}`;
}

/** The reminder's default title: "Call back <name>", or bare "Call back". */
export function followUpTitleKey(
  customerName: string | null | undefined
): { key: 'titleNamed'; values: { name: string } } | { key: 'titleBare' } {
  const name = customerName?.trim();
  return name ? { key: 'titleNamed', values: { name } } : { key: 'titleBare' };
}
