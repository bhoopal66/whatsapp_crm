// ============================================================
// Who may come back into a locked meeting (176).
// ============================================================

/** How long after a seat closes its person still counts as mid-call. */
export const LOCKED_REJOIN_WINDOW_MS = 5 * 60_000;

/**
 * A dropped connection rejoins from scratch and the old seat is closed
 * first, so someone already inside must get past the lock: they hold an
 * open seat, or one that closed within the window.
 */
export function mayEnterLocked(
  seats: readonly { left_at: string | null }[],
  nowMs: number
): boolean {
  return seats.some(
    (s) =>
      !s.left_at || nowMs - Date.parse(s.left_at) <= LOCKED_REJOIN_WINDOW_MS
  );
}
