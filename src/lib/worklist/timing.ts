/**
 * The worklist's "when" column (Track B item 10): plain wording such as
 * "Overdue by 2 h" or "Waiting 18 h" instead of the ranking score. Pure.
 *
 * The score (`rank.ts`, hire fast's `scoreCandidate`) still orders the
 * list; it is built from the same clocks shown here: how long a person
 * has waited on us (hire fast's `waitingHours`), an overdue HR task, the
 * recruiter no-activity rule, a case's SLA timer and a draft's age.
 */

export const WORKLIST_TIMING_STATES = ['overdue', 'waiting', 'due_in'] as const;
export type WorklistTimingState = (typeof WORKLIST_TIMING_STATES)[number];

export interface WorklistTiming {
  /**
   * overdue: `at` is when it fell due. waiting: `at` is when the wait
   * began. due_in: `at` is when it falls due (in the future).
   */
  state: WorklistTimingState;
  /** Epoch milliseconds. */
  at: number;
}

export type DurationUnit = 'minutes' | 'hours' | 'days';

export interface TimingLabel {
  state: WorklistTimingState;
  unit: DurationUnit;
  n: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * A length of time in the unit a person would say: minutes under an
 * hour (at least 1), hours up to 48, then whole days. Like hire fast's
 * `waitingLabel`, so the two screens read the same.
 */
export function durationParts(ms: number): { unit: DurationUnit; n: number } {
  const span = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (span < HOUR)
    return { unit: 'minutes', n: Math.max(1, Math.floor(span / MINUTE)) };
  const hours = Math.floor(span / HOUR);
  if (hours < 48) return { unit: 'hours', n: hours };
  return { unit: 'days', n: Math.floor(hours / 24) };
}

/**
 * The wording for an item's timing at `now`; null when it has none (a
 * dash). A due time that has already passed reads as overdue.
 */
export function timingLabel(
  timing: WorklistTiming | null,
  now: number
): TimingLabel | null {
  if (!timing || !Number.isFinite(timing.at)) return null;
  let state = timing.state;
  if (state === 'due_in' && timing.at <= now) state = 'overdue';
  const span = state === 'due_in' ? timing.at - now : now - timing.at;
  return { state, ...durationParts(span) };
}

/** The i18n key (under `Worklist`) of a timing label. */
export function timingKey(
  state: WorklistTimingState
): `timing.${WorklistTimingState}` {
  return `timing.${state}`;
}
