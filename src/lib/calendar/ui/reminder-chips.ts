// Reminder chips (minutes before the start) — pure.

import { REMINDER_MAX_MINUTES, REMINDERS_MAX } from '../validate';

/** At start, 5, 10, 15, 30 min, 1 h, 1 day. */
export const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 1440] as const;

/**
 * For an all-day event the offsets count back from local midnight, so the
 * chips are times of the day before: 18:00 (360), 09:00 (900), and
 * midnight itself (0). "None" is no chip selected.
 */
export const ALL_DAY_REMINDER_PRESETS = [0, 360, 900] as const;

/** The chips an event offers. */
export function reminderPresets(allDay: boolean): readonly number[] {
  return allDay ? ALL_DAY_REMINDER_PRESETS : REMINDER_PRESETS;
}

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

export type ReminderLabel =
  | { key: 'atStart' | 'minutes' | 'hours' | 'days'; count: number }
  | { key: 'atMidnight'; count: 0 }
  | { key: 'dayBefore'; count: 1; time: string }
  | { key: 'daysBefore'; count: number; time: string };

/**
 * Keys under `Calendar.reminders`, with the count they take. For an
 * all-day event `minutes` is the time before local midnight of the first
 * day, so 900 reads "9:00 the day before" and not "15 hours".
 */
export function reminderLabel(minutes: number, allDay = false): ReminderLabel {
  if (allDay) {
    if (minutes === 0) return { key: 'atMidnight', count: 0 };
    const days = Math.ceil(minutes / 1440);
    const ofDay = days * 1440 - minutes;
    const time = `${Math.floor(ofDay / 60)}:${String(ofDay % 60).padStart(2, '0')}`;
    return days === 1
      ? { key: 'dayBefore', count: 1, time }
      : { key: 'daysBefore', count: days, time };
  }
  if (minutes === 0) return { key: 'atStart', count: 0 };
  if (minutes % 1440 === 0) return { key: 'days', count: minutes / 1440 };
  if (minutes % 60 === 0) return { key: 'hours', count: minutes / 60 };
  return { key: 'minutes', count: minutes };
}
