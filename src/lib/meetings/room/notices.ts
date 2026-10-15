// Notices derived from `meeting_participants` rows: who joined or left
// (by person, so a reconnect's new seat is not a join), and what the
// host did to our own seat.

import type { ParticipantRow } from './types';

export type JoinLeaveDraft =
  { kind: 'joined'; userId: string } | { kind: 'left'; userId: string };

/**
 * `before` is the set of people present at the previous plan, or null
 * when the room has just loaded: the first plan only records who is
 * there, or everyone already in the call would read as having joined.
 * Never about ourselves (`selfUserId`, or our own seat).
 */
export function presenceNotices(
  before: ReadonlySet<string> | null,
  present: readonly ParticipantRow[],
  self: { userId: string | null; participantId: string | null }
): { users: Set<string>; notices: JoinLeaveDraft[] } {
  const users = new Set(
    present
      .filter((r) => r.id !== self.participantId && r.user_id !== self.userId)
      .map((r) => r.user_id)
  );
  if (before === null) return { users, notices: [] };
  const notices: JoinLeaveDraft[] = [];
  for (const u of users)
    if (!before.has(u)) notices.push({ kind: 'joined', userId: u });
  for (const u of before)
    if (!users.has(u)) notices.push({ kind: 'left', userId: u });
  return { users, notices };
}

export interface SelfRowMemo {
  muteRequestedAt: string | null;
  handRaisedAt: string | null;
}

/**
 * What a new version of our own row asks of us. `prev` is the last
 * version seen on this seat (null for the first); `handWanted` is what
 * we last asked for, so a hand we lowered ourselves is not "lowered by
 * the host".
 */
export function selfRowEffects(
  prev: SelfRowMemo | null,
  row: Pick<
    ParticipantRow,
    'mute_requested_at' | 'hand_raised_at' | 'removed_at'
  >,
  handWanted: boolean
): {
  memo: SelfRowMemo;
  mute: boolean;
  handLoweredByHost: boolean;
  removed: boolean;
} {
  const req = row.mute_requested_at;
  const seen = prev?.muteRequestedAt ?? null;
  const mute =
    req !== null && (seen === null || Date.parse(req) > Date.parse(seen));
  return {
    memo: {
      muteRequestedAt: mute ? req : seen,
      handRaisedAt: row.hand_raised_at,
    },
    mute,
    handLoweredByHost:
      handWanted && !!prev?.handRaisedAt && row.hand_raised_at === null,
    removed: row.removed_at !== null,
  };
}

/** Notices kept for the screen at most; older ones are dropped. */
export const NOTICE_LIMIT = 20;

/** `drafts` appended with fresh ids, the oldest dropped past the limit. */
export function pushNotices<N extends { id: string }>(
  list: readonly N[],
  drafts: readonly Omit<N, 'id'>[],
  nextId: () => string
): N[] {
  if (!drafts.length) return list as N[];
  const added = drafts.map((d) => ({ ...d, id: nextId() }) as N);
  return [...list, ...added].slice(-NOTICE_LIMIT);
}

/** The notices left once the screen has shown `ids`. */
export function dismissNotices<N extends { id: string }>(
  list: readonly N[],
  ids: readonly string[]
): N[] {
  const drop = new Set(ids);
  const kept = list.filter((n) => !drop.has(n.id));
  return kept.length === list.length ? (list as N[]) : kept;
}
