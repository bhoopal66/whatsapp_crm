/**
 * Rate-limited accounting for Meta callbacks the webhook drops because
 * their `phone_number_id` is not connected here.
 *
 * Dropping them is right — they are answered 200 so Meta neither retries
 * nor disables the app-wide subscription the connected number shares —
 * but the route used to log one line per POST. One unconnected number
 * on a WABA subscribed to this app made that more than half of the
 * whole application log, and each line named only the id, so the log
 * still could not say whether customers were writing to that number or
 * Meta was only reporting receipts for sends made elsewhere.
 *
 * So: one line the first time an id is seen, then at most one summary
 * per interval per id, with the messages/statuses split. There are no
 * timers — a summary is emitted by the next drop after the interval has
 * passed — so drops at the tail of a quiet spell wait for the next one.
 * State is per process, which suits the one long-lived standalone
 * server, and is lost on restart.
 *
 * The counts come from a body whose signature was never checked (there
 * is no connected row to check it with), so on their own they are
 * indicative only. `signed` is how the route makes them authoritative:
 * it says whether the body verified against an app secret stored here,
 * i.e. whether it was THIS app that delivered it.
 */

import type { RawMetaWebhookPayload } from './meta-webhook';

export const DROP_TALLY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The id comes from an unauthenticated body, so a caller naming a fresh
 * id on every POST must not grow the map without bound. Past the cap
 * the oldest id is forgotten; it would log a first-sight line again,
 * which is no worse than the one-line-per-POST this replaced.
 */
const MAX_TRACKED_IDS = 256;

/** Longest id kept or logged — real ones are ~15 digits. */
const MAX_ID_LENGTH = 64;

export interface DroppedCallback {
  messages: number;
  statuses: number;
  /** The body verified against an app secret stored on this install. */
  signed: boolean;
}

/**
 * How many messages and receipts one callback carried for one number.
 * Walks the same changes `metaPhoneNumberIds` does: `field: 'messages'`
 * (or unnamed) with a matching `metadata.phone_number_id`.
 */
export function countDroppedEvents(
  payload: RawMetaWebhookPayload,
  phoneNumberId: string
): { messages: number; statuses: number } {
  let messages = 0;
  let statuses = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value;
      if (value?.metadata?.phone_number_id !== phoneNumberId) continue;
      if (Array.isArray(value.messages)) messages += value.messages.length;
      if (Array.isArray(value.statuses)) statuses += value.statuses.length;
    }
  }
  return { messages, statuses };
}

interface Bucket {
  callbacks: number;
  messages: number;
  statuses: number;
  signed: number;
  since: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function summarise(b: Omit<Bucket, 'since'>): string {
  return (
    `${plural(b.messages, 'message')}, ${plural(b.statuses, 'status', 'statuses')}` +
    ` (${b.signed}/${b.callbacks} signed by this app)`
  );
}

/**
 * The id as a string. It is typed one, but it comes out of an unchecked
 * body, and `slice()` on a number or object threw — a 500 and a stack
 * trace per forged POST, from the very code meant to quiet the log.
 */
function idString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    // JSON can build an object String() cannot convert: {"toString":null}.
    return `<${typeof value}>`;
  }
}

export interface DropTally {
  /**
   * Count one dropped callback. Returns the line to log, or null when
   * this drop only adds to the running summary.
   */
  record(phoneNumberId: string, drop: DroppedCallback): string | null;
}

export function createDropTally(
  options: {
    intervalMs?: number;
    now?: () => number;
    maxIds?: number;
  } = {}
): DropTally {
  const intervalMs = options.intervalMs ?? DROP_TALLY_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const maxIds = options.maxIds ?? MAX_TRACKED_IDS;
  const buckets = new Map<string, Bucket>();

  return {
    record(phoneNumberId, drop) {
      const id = idString(phoneNumberId).slice(0, MAX_ID_LENGTH);
      // JSON-quoted: the id is attacker-controlled, and a raw newline in
      // it would forge a log line.
      const label = JSON.stringify(id);
      const t = now();
      const signed = drop.signed ? 1 : 0;

      const bucket = buckets.get(id);
      if (!bucket) {
        if (buckets.size >= maxIds) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
        // This drop is reported now, so the running summary starts empty.
        buckets.set(id, {
          callbacks: 0,
          messages: 0,
          statuses: 0,
          signed: 0,
          since: t,
        });
        return (
          `[meta-webhook] dropped 1 callback for unconnected phone_number_id ${label}` +
          ` (first seen; further drops are summarised at most every ${Math.round(intervalMs / 60_000)}m): ` +
          summarise({ callbacks: 1, ...drop, signed })
        );
      }

      bucket.callbacks += 1;
      bucket.messages += drop.messages;
      bucket.statuses += drop.statuses;
      bucket.signed += signed;
      if (t - bucket.since < intervalMs) return null;

      const minutes = Math.round((t - bucket.since) / 60_000);
      const line =
        `[meta-webhook] dropped ${plural(bucket.callbacks, 'callback')} for unconnected` +
        ` phone_number_id ${label} in the last ${minutes}m: ${summarise(bucket)}`;
      buckets.set(id, {
        callbacks: 0,
        messages: 0,
        statuses: 0,
        signed: 0,
        since: t,
      });
      return line;
    },
  };
}
