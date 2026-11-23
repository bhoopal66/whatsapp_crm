import {
  ringingExtensions,
  type CallStateEvent,
  type YeastarEvent,
} from './yeastar/events';

/**
 * What the retry sweep (housekeeping.ts) does with one stored event that
 * was never stamped processed. Pure: the rows it judges are read there.
 *
 * Nothing on the row tells a live event from a past one imported from the
 * CDR (`historical`) whose run was interrupted, so an event is judged by
 * its age, and an end by the call's own end too.
 */

/** A row with no error this young may still be in its first run. */
export const INTERRUPTED_AFTER_MS = 2 * 60_000;
/** Past this an event is `late` (StoredEventInput.late). */
export const LATE_AFTER_MS = 60 * 60_000;
/** Presence and ringing older than this say nothing about now. */
export const LIVE_STATE_MAX_AGE_MS = 60_000;

/** Fixed wording: kept as pbx_events_raw.error on a stamped row. */
export const RETRY_SKIP = {
  late: 'not retried: too old, and not a call end',
  oldState: 'not retried: too old for a live status',
  superseded: 'not retried: a newer status was written since',
} as const;

/** An unreadable time counts as old. */
const olderThan = (ms: number, atMs: number, nowMs: number): boolean =>
  !(nowMs - atMs <= ms);

/** Failed (an error is set), or interrupted: no outcome, and not just in. */
export function dueForRetry(
  row: { received_at: string; error: string | null },
  nowMs: number
): boolean {
  return (
    row.error !== null ||
    olderThan(INTERRUPTED_AFTER_MS, Date.parse(row.received_at), nowMs)
  );
}

/** Every party has hung up: the frame only removes the screen pop. */
export const isAllBye = (ev: CallStateEvent): boolean =>
  ev.members.length > 0 &&
  ev.members.every((m) => m.status.toUpperCase() === 'BYE');

/** The row an event overwrites, which may have been written since. */
export interface RetryStateRow {
  table: 'call_live' | 'pbx_presence' | 'pbx_extensions';
  column: 'pbx_call_id' | 'extension';
  value: string;
}

export function retryStateRow(
  event: YeastarEvent | null
): RetryStateRow | null {
  switch (event?.kind) {
    case 'call_state':
      return isAllBye(event)
        ? null
        : { table: 'call_live', column: 'pbx_call_id', value: event.callId };
    case 'presence':
    case 'extension_call_state':
      return {
        table: 'pbx_presence',
        column: 'extension',
        value: event.extension,
      };
    case 'registration':
      return {
        table: 'pbx_extensions',
        column: 'extension',
        value: event.extension,
      };
    default:
      return null;
  }
}

export type RetryDecision =
  { run: true; late: boolean } | { run: false; reason: string };

export function retryDecision(input: {
  /** Null: the frame cannot be parsed, which the run stamps. */
  event: YeastarEvent | null;
  receivedAt: string;
  /** `updated_at` of retryStateRow's row; null when there is none. */
  stateUpdatedAt: string | null;
  nowMs: number;
}): RetryDecision {
  const { event, stateUpdatedAt, nowMs } = input;
  const receivedMs = Date.parse(input.receivedAt);
  const late = olderThan(LATE_AFTER_MS, receivedMs, nowMs);
  if (!event) return { run: true, late };
  if (event.kind === 'call_end') {
    // A call whose time cannot be read may be hours old: late too.
    const endMs = Date.parse(event.startedAt ?? '') + event.callSeconds * 1000;
    return { run: true, late: late || olderThan(LATE_AFTER_MS, endMs, nowMs) };
  }
  if (event.kind === 'call_state' && isAllBye(event)) {
    return { run: true, late };
  }
  if (late) return { run: false, reason: RETRY_SKIP.late };
  if (!retryStateRow(event)) return { run: true, late: false };
  if (stateUpdatedAt !== null && Date.parse(stateUpdatedAt) > receivedMs) {
    return { run: false, reason: RETRY_SKIP.superseded };
  }
  // Anyone ringing, not only a call nobody answered: a person's screen
  // rings on ringing_user_ids while answered_by is empty (call-ui.ts), and
  // an answering extension without a person leaves it empty.
  const momentary =
    event.kind !== 'call_state' || ringingExtensions(event).length > 0;
  return momentary && olderThan(LIVE_STATE_MAX_AGE_MS, receivedMs, nowMs)
    ? { run: false, reason: RETRY_SKIP.oldState }
    : { run: true, late: false };
}
