// Reminder chips (minutes before the start) — pure.

import { REMINDER_MAX_MINUTES, REMINDERS_MAX } from '../validate';

/** At start, 5, 10, 15, 30 min, 1 h, 1 day. */
export const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 1440] as const;

/** Add or remove a chip; adding past the limit changes nothing. */
export function toggleReminder(list: readonly number[], minutes: number) {
  if (list.includes(minutes)) return list.filter((m) => m !== minutes);
  if (list.length >= REMINDERS_MAX) return [...list];
  return [...list, minutes].sort((a, b) => a - b);
}

/**
 * A typed custom reminder: whole minutes, or with an `m`, `h` or `d`
 * suffix ("90", "2h", "1d"). Null when it is not one, or out of range.
 */
export function parseCustomReminder(input: string): number | null {
  const m = /^\s*(\d{1,5})\s*([mhd]?)\s*$/i.exec(input);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const minutes = Number(m[1]) * (unit === 'd' ? 1440 : unit === 'h' ? 60 : 1);
  if (minutes > REMINDER_MAX_MINUTES) return null;
  return minutes;
}

/** Keys under `Calendar.reminders`, with the count they take. */
export function reminderLabel(minutes: number): {
  key: 'atStart' | 'minutes' | 'hours' | 'days';
  count: number;
} {
  if (minutes === 0) return { key: 'atStart', count: 0 };
  if (minutes % 1440 === 0) return { key: 'days', count: minutes / 1440 };
  if (minutes % 60 === 0) return { key: 'hours', count: minutes / 60 };
  return { key: 'minutes', count: minutes };
}
