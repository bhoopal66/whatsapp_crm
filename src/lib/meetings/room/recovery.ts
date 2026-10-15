/**
 * What a failed pull (receiving other participants' tracks) does next.
 *
 * A pull is POST tracks/new (remote) → the SFU's offer → our answer →
 * PUT renegotiate. A failure before the offer is applied touched
 * nothing locally, and the next replan simply asks again. A failure
 * after it touched signalling, and is a strike:
 * - stuck in `have-remote-offer` (createAnswer / setLocalDescription
 *   threw), the offer is rolled back, or every later createOffer throws
 *   InvalidStateError while ICE stays connected, so the connection-state
 *   rejoin never fires;
 * - the answer applied but its PUT failed, Cloudflare never saw it and
 *   the transceivers the offer created are orphans; the hook stops them.
 * One strike retries on the next plan. A second in a row, or a
 * connection still not `stable` after the rollback, rejoins from scratch
 * rather than piling up orphan transceivers every 5 s.
 *
 * Signalling states are plain strings so this file needs no DOM lib.
 */

export const PULL_STRIKES_BEFORE_REJOIN = 2;

/** Roll back an offer the failed pull applied but never answered. */
export function needsPullRollback(signalingState: string): boolean {
  return signalingState === 'have-remote-offer';
}

/**
 * After a strike has been cleaned up: the new count, and whether the
 * room should rejoin. `signalingStateAfterCleanup` is read once the
 * rollback (if any) has run.
 */
export function afterPullStrike(
  strikes: number,
  signalingStateAfterCleanup: string
): { strikes: number; rejoin: boolean } {
  const next = strikes + 1;
  return {
    strikes: next,
    rejoin:
      next >= PULL_STRIKES_BEFORE_REJOIN ||
      signalingStateAfterCleanup !== 'stable',
  };
}
