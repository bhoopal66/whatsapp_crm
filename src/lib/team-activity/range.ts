// ============================================================
// The Team activity page's date ranges, in the account's time zone.
//
// "Today" has to mean the same day for the limits, the alerts and the
// report, so the boundaries are computed in the zone the settings name
// (or the viewer's, before an admin saves one) rather than in the
// server's or the browser's local time. Pure: no I/O.
// ============================================================

export const RANGE_PRESETS = [
  'today',
  'yesterday',
  '7d',
  '30d',
  '90d',
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export function isRangePreset(value: unknown): value is RangePreset {
  return (
    typeof value === 'string' &&
    (RANGE_PRESETS as readonly string[]).includes(value)
  );
}

/** Milliseconds the zone is ahead of UTC at `instant` (negative west of UTC). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  // Whole seconds only: the formatted parts drop the milliseconds.
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/** The calendar date (y, m 1-12, d) at `instant` in `timeZone`. */
function zonedDate(
  instant: number,
  timeZone: string
): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * The instant local midnight began, `daysAgo` days before the local
 * date of `now`, in `timeZone`. Correct across DST changes: the
 * offset is re-read at the candidate instant.
 */
export function zonedDayStart(now: Date, timeZone: string, daysAgo = 0): Date {
  const { y, m, d } = zonedDate(now.getTime(), timeZone);
  const localMidnightAsUtc = Date.UTC(y, m - 1, d - daysAgo);
  let guess = localMidnightAsUtc - zoneOffsetMs(localMidnightAsUtc, timeZone);
  const corrected = localMidnightAsUtc - zoneOffsetMs(guess, timeZone);
  if (corrected !== guess) guess = corrected;
  return new Date(guess);
}

/** [from, to) for a preset, ending now except for "yesterday". */
export function rangeFor(
  preset: RangePreset,
  now: Date,
  timeZone: string
): { from: Date; to: Date } {
  switch (preset) {
    case 'today':
      return { from: zonedDayStart(now, timeZone, 0), to: now };
    case 'yesterday':
      return {
        from: zonedDayStart(now, timeZone, 1),
        to: zonedDayStart(now, timeZone, 0),
      };
    case '7d':
      return { from: zonedDayStart(now, timeZone, 6), to: now };
    case '30d':
      return { from: zonedDayStart(now, timeZone, 29), to: now };
    case '90d':
      return { from: zonedDayStart(now, timeZone, 89), to: now };
  }
}
