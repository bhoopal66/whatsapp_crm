/**
 * The `calls.meta` keys the stale-call step (stale-calls.ts) writes. Kept
 * apart from both stale-calls.ts and process.ts, which import each other's
 * neighbourhood: the call-end path drops them (a real end supersedes any
 * guess or retry state), the stale step writes them.
 */

/**
 * Where `meta` records a call settled without its CDR. migration 089's
 * CHECK has no "unknown" status, so the status chosen (see
 * `unsettledStatus`) is a best guess and this says so.
 */
export const UNSETTLED_META_KEY = 'settled_without_cdr';
/** When the step last checked a call it left live (the batch's order). */
export const STALE_CHECKED_META_KEY = 'stale_checked_at';
/** How many runs found the call's CDR but failed to ingest it. */
export const STALE_FAILURES_META_KEY = 'stale_ingest_failures';

const STALE_KEYS = [
  UNSETTLED_META_KEY,
  STALE_CHECKED_META_KEY,
  STALE_FAILURES_META_KEY,
];

/** A copy of `meta` without the stale step's keys: a real end wins. */
export function withoutStaleMarkers<T extends Record<string, unknown>>(
  meta: T
): T {
  const out = { ...meta };
  for (const key of STALE_KEYS) delete out[key];
  return out;
}
