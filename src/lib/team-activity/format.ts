// ============================================================
// Small display helpers for the Team activity page. Pure.
// ============================================================

/** Split minutes into whole days, hours and minutes. */
export function splitMinutes(total: number): {
  d: number;
  h: number;
  m: number;
} {
  const mins = Math.max(0, Math.round(total));
  return {
    d: Math.floor(mins / 1440),
    h: Math.floor((mins % 1440) / 60),
    m: mins % 60,
  };
}

/**
 * "45m", "1h 20m", "2d 3h": the two largest non-zero units, rounded to
 * the minute. Unit words come from the caller (translated).
 */
export function formatMinutes(
  total: number | null | undefined,
  unit: (u: 'd' | 'h' | 'm', n: number) => string
): string | null {
  if (total === null || total === undefined || !Number.isFinite(total)) {
    return null;
  }
  if (total < 1) return unit('m', total <= 0 ? 0 : 1);
  const { d, h, m } = splitMinutes(total);
  const parts: string[] = [];
  if (d) parts.push(unit('d', d));
  if (h) parts.push(unit('h', h));
  if (m && parts.length < 2 && !d) parts.push(unit('m', m));
  return parts.slice(0, 2).join(' ') || unit('m', 0);
}

/** Percentage of `part` in `whole`, rounded; null when whole is 0. */
export function percent(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 100);
}

/** "22:00" for an hour of the day. */
export function hourLabel(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}
