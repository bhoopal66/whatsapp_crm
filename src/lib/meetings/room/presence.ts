import type { ParticipantRow } from './types';

/** Clients heartbeat this often (POST /api/meetings/[id]/heartbeat). */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** A row whose last heartbeat is older than this is not in the room. */
export const PRESENCE_WINDOW_MS = 60_000;

/**
 * Present = not left, and heard from within the window. `nowMs` is the
 * server's clock as the browser best knows it (`Date.now() + skew`),
 * because `last_seen_at` is stamped by the database.
 */
export function isPresent(row: ParticipantRow, nowMs: number): boolean {
  if (row.left_at !== null) return false;
  const seen = Date.parse(row.last_seen_at);
  if (Number.isNaN(seen)) return false;
  return nowMs - seen < PRESENCE_WINDOW_MS;
}

/** The present rows, oldest joiner first (a stable tile order). */
export function presentParticipants(
  rows: Iterable<ParticipantRow>,
  nowMs: number
): ParticipantRow[] {
  return [...rows]
    .filter((r) => isPresent(r, nowMs))
    .sort(
      (a, b) =>
        Date.parse(a.joined_at) - Date.parse(b.joined_at) ||
        a.id.localeCompare(b.id)
    );
}

/**
 * Server clock minus browser clock, from a timestamp the database just
 * wrote (our own row's `last_seen_at`, echoed by realtime right after a
 * heartbeat). A browser clock a minute off would otherwise show an
 * empty room, or keep a crashed peer's tile forever. Transit time makes
 * the estimate slightly low, which only ages rows by that much.
 */
export function clockSkewMs(serverIso: string, localNowMs: number): number {
  const server = Date.parse(serverIso);
  return Number.isNaN(server) ? 0 : server - localNowMs;
}

/** When the call went live: the earliest `joined_at` of those present. */
export function liveSince(present: readonly ParticipantRow[]): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const r of present) {
    const ms = Date.parse(r.joined_at);
    if (!Number.isNaN(ms) && ms < bestMs) {
      bestMs = ms;
      best = r.joined_at;
    }
  }
  return best;
}
