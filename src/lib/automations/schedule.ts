// Preset <-> stored-value conversion for the automation builder's time
// fields. The stored formats do not change:
//
// - A `time_based` trigger keeps `trigger_config.schedule` as a 5-field
//   cron expression (validate.ts only requires it to be non-empty;
//   older rows may hold a plain "HH:mm", which TimeBasedTriggerConfig
//   documents as "every day at"). Presets write ordinary cron; anything
//   that is not a preset stays editable as raw text ("custom").
// - A `time_of_day` condition keeps `operand` as "HH:mm-HH:mm", the
//   window engine.ts's evaluateCondition reads (over-midnight ranges
//   like "18:00-09:00" included).

import { formatClock, parseClock } from '@/lib/time-of-day';

export type ScheduleMode = 'daily' | 'weekdays' | 'hourly' | 'custom';
export type SchedulePreset = Exclude<ScheduleMode, 'custom'>;

export const SCHEDULE_MODES: readonly ScheduleMode[] = [
  'daily',
  'weekdays',
  'hourly',
  'custom',
];

/** What a new time-based trigger starts with: every day at 09:00. */
export const DEFAULT_SCHEDULE_TIME = '09:00';
export const DEFAULT_SCHEDULE = '0 9 * * *';

export interface ParsedSchedule {
  mode: ScheduleMode;
  /** "HH:mm" for daily / weekdays; null otherwise. */
  time: string | null;
}

const CRON_AT = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5)$/;
const CRON_HOURLY = /^0\s+\*\s+\*\s+\*\s+\*$/;

/** Reads a stored schedule back into the preset it was made from. */
export function parseSchedule(
  value: string | null | undefined
): ParsedSchedule {
  const v = (value ?? '').trim();
  if (CRON_HOURLY.test(v)) return { mode: 'hourly', time: null };
  const at = CRON_AT.exec(v);
  if (at) {
    const minute = Number(at[1]);
    const hour = Number(at[2]);
    if (minute <= 59 && hour <= 23) {
      return {
        mode: at[3] === '1-5' ? 'weekdays' : 'daily',
        time: formatClock(hour, minute),
      };
    }
  }
  // Legacy "HH:mm" rows mean "every day at that time".
  const clock = parseClock(v);
  if (clock)
    return { mode: 'daily', time: formatClock(clock.hour, clock.minute) };
  return { mode: 'custom', time: null };
}

/**
 * The cron expression for a preset. `time` ("HH:mm") is used by daily
 * and weekdays; an unreadable one falls back to 09:00.
 */
export function buildSchedule(
  preset: SchedulePreset,
  time?: string | null
): string {
  if (preset === 'hourly') return '0 * * * *';
  const clock = parseClock(time) ?? parseClock(DEFAULT_SCHEDULE_TIME)!;
  const dow = preset === 'weekdays' ? '1-5' : '*';
  return `${clock.minute} ${clock.hour} * * ${dow}`;
}

export interface TimeRange {
  from: string;
  to: string;
}

export const DEFAULT_TIME_RANGE: TimeRange = { from: '09:00', to: '18:00' };

/** Reads a condition's "HH:mm-HH:mm" operand; null when it is not one. */
export function parseTimeRange(
  value: string | null | undefined
): TimeRange | null {
  const parts = (value ?? '').split('-');
  if (parts.length !== 2) return null;
  const from = parseClock(parts[0]);
  const to = parseClock(parts[1]);
  if (!from || !to) return null;
  return {
    from: formatClock(from.hour, from.minute),
    to: formatClock(to.hour, to.minute),
  };
}

export function formatTimeRange(range: TimeRange): string {
  return `${range.from}-${range.to}`;
}
