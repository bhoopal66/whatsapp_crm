// Small display rules of a stage tile: the avatar's size and backdrop,
// a raised hand's place in the queue, and the link an empty room shares.

import type { ParticipantId } from '@/lib/meetings/room/contract';

import { avatarColor, type AVATAR_COLORS } from './people';

const AVATAR_SHARE = 0.32;
const AVATAR_MIN_PX = 40;
const AVATAR_MAX_PX = 128;

/** About a third of the tile's smaller side, within 40–128 px. */
export function tileAvatarSize(box: { width: number; height: number }): number {
  const side = Math.min(box.width, box.height) * AVATAR_SHARE;
  return Math.round(Math.min(AVATAR_MAX_PX, Math.max(AVATAR_MIN_PX, side)));
}

// Complete literals: Tailwind cannot see a class name put together here.
const AVATAR_TINTS: Record<(typeof AVATAR_COLORS)[number], string> = {
  'bg-sky-600': 'bg-sky-500/15',
  'bg-emerald-600': 'bg-emerald-500/15',
  'bg-violet-600': 'bg-violet-500/15',
  'bg-amber-600': 'bg-amber-500/15',
  'bg-rose-600': 'bg-rose-500/15',
  'bg-teal-600': 'bg-teal-500/15',
  'bg-indigo-600': 'bg-indigo-500/15',
  'bg-fuchsia-600': 'bg-fuchsia-500/15',
};

/** The soft backdrop behind a person's avatar, in their avatar's hue. */
export function avatarTint(userId: string): string {
  return AVATAR_TINTS[avatarColor(userId)];
}

export interface HandRow {
  id: ParticipantId;
  hand_raised_at: string | null;
}

/**
 * A raised hand's place in the queue, from 1; null when it is not up.
 * Earliest first, compared as `orderPeople` compares, so the tile and the
 * people panel agree. Our own hand follows `selfRaised`, which moves
 * before our row does: raised a moment ago it is last in the queue, and
 * just lowered it has left it.
 */
export function handQueueRank(
  rows: readonly HandRow[],
  participantId: ParticipantId,
  selfId: ParticipantId | null,
  selfRaised: boolean
): number | null {
  const queue = rows
    .filter((r) => r.hand_raised_at && (r.id !== selfId || selfRaised))
    .sort(
      (a, b) =>
        a.hand_raised_at!.localeCompare(b.hand_raised_at!) ||
        a.id.localeCompare(b.id)
    )
    .map((r) => r.id);
  if (selfRaised && selfId && !queue.includes(selfId)) queue.push(selfId);
  const place = queue.indexOf(participantId);
  return place < 0 ? null : place + 1;
}

/** The address someone opens to reach this meeting. */
export function meetingLink(origin: string, meetingId: string): string {
  return `${origin}/meetings/${meetingId}`;
}
