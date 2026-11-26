// ============================================================
// Presence helpers — pure, unit-testable, no I/O.
//
// Mirrors the `member_presence` table from migration
// 024_member_presence.sql. The DB stores only what the active
// client reports ('online' / 'away'); "offline" is never stored
// — it is derived here from staleness so a closed tab resolves to
// offline without an unload write.
//
// `now` is always passed in (epoch ms) rather than read from the
// clock, so derivation and formatting stay deterministic and
// testable. See presence.test.ts.
// ============================================================

/** How often the active client heartbeats its own presence row. */
export const HEARTBEAT_MS = 30_000;

/**
 * A member whose last heartbeat is older than this is treated as
 * offline regardless of its stored status. ~2.5 missed beats, so a
 * single dropped heartbeat doesn't flap a member offline.
 */
export const OFFLINE_AFTER_MS = 75_000;

/** No input / hidden tab for this long flips the client to 'away'. */
export const IDLE_AFTER_MS = 5 * 60_000;

/** What the active client reports (and what the DB stores). */
export type StoredPresence = "online" | "away";

/** What a viewer sees — adds the derived 'offline' state. */
export type PresenceStatus = "online" | "away" | "offline";

/** Raw presence row as read from the `member_presence` table. */
export interface PresenceRow {
  status: StoredPresence;
  last_seen_at: string;
}

/**
 * Derive the user-facing presence for a member. A missing row, or a
 * heartbeat staler than OFFLINE_AFTER_MS, reads as offline; otherwise
 * the member's last reported status (online / away) stands.
 */
export function derivePresence(
  stored: StoredPresence | undefined,
  lastSeenAt: string | null | undefined,
  now: number,
): PresenceStatus {
  if (!stored || !lastSeenAt) return "offline";
  const last = new Date(lastSeenAt).getTime();
  if (Number.isNaN(last)) return "offline";
  if (now - last > OFFLINE_AFTER_MS) return "offline";
  return stored;
}

/** When someone offline was last seen, or null when that is not known. */
export function lastSeenDate(
  lastSeenAt: string | null | undefined,
  now: number,
): Date | null {
  const last = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
  // A clock ahead of ours is "now", never the future.
  return Number.isNaN(last) ? null : new Date(Math.min(last, now));
}

/** The catalogue keys of a presence dot's tooltip (`Presence.*`). */
export type PresenceTooltip =
  | { key: "onlineNow" | "awayIdle" | "offlineUnknown" }
  | { key: "offlineSince"; lastSeen: Date };

export function presenceTooltip(
  status: PresenceStatus,
  lastSeenAt: string | null | undefined,
  now: number,
): PresenceTooltip {
  if (status === "online") return { key: "onlineNow" };
  if (status === "away") return { key: "awayIdle" };
  const lastSeen = lastSeenDate(lastSeenAt, now);
  return lastSeen ? { key: "offlineSince", lastSeen } : { key: "offlineUnknown" };
}

/** Roster header summary, e.g. for "3 online · 1 away · 1 offline". */
export function summarize(statuses: PresenceStatus[]): {
  online: number;
  away: number;
  offline: number;
} {
  const counts = { online: 0, away: 0, offline: 0 };
  for (const s of statuses) counts[s] += 1;
  return counts;
}
