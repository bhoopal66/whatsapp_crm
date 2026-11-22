// Pure helpers for a 24-hour "HH:mm" clock value, shared by the
// TimePicker control (src/components/ui/time-picker.tsx) and any form
// that stores a time of day as text. No DOM, no clock.

export interface Clock {
  hour: number;
  minute: number;
}

/** Parses "H:mm" / "HH:mm" (24-hour). Anything else is null. */
export function parseClock(value: string | null | undefined): Clock | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value ?? '');
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Formats an hour and minute as zero-padded "HH:mm". */
export function formatClock(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "00" … "23". */
export function hourOptions(): string[] {
  return Array.from({ length: 24 }, (_, h) => pad2(h));
}

/**
 * Minutes on a `step` grid ("00", "05", …), plus `current` when it is
 * off the grid, so a stored 09:07 still shows as 07 instead of
 * silently snapping to another minute.
 */
export function minuteOptions(step = 5, current?: number | null): string[] {
  const s = Number.isInteger(step) && step >= 1 && step <= 60 ? step : 5;
  const out: number[] = [];
  for (let m = 0; m < 60; m += s) out.push(m);
  if (
    current != null &&
    Number.isInteger(current) &&
    current >= 0 &&
    current < 60 &&
    !out.includes(current)
  ) {
    out.push(current);
    out.sort((a, b) => a - b);
  }
  return out.map(pad2);
}
