/**
 * Team-chat moderation (160), the pure pieces the UI needs: who may
 * remove someone else's message, the reason the database requires for
 * it, and posting timeouts. The database decides; these only choose
 * what to offer.
 */
import type { ChannelKind, ChannelRole, ChatMessage } from './types';

/** chat_delete_message / chat_restrict_member: a reason of 5–500 characters. */
export const MODERATION_REASON_MIN = 5;
export const MODERATION_REASON_MAX = 500;

/** Character count as Postgres's char_length sees it (code points). */
export const reasonLength = (s: string): number => [...s.trim()].length;

export function moderationReasonValid(s: string): boolean {
  const n = reasonLength(s);
  return n >= MODERATION_REASON_MIN && n <= MODERATION_REASON_MAX;
}

/** Channel admins moderate only team and private channels. */
export const moderatedKind = (kind: ChannelKind): boolean =>
  kind === 'team' || kind === 'private';

/**
 * The viewer moderates this channel as its admin: member role 'admin',
 * not a bank guest, in a team or private channel.
 */
export function isChannelModerator(i: {
  kind: ChannelKind;
  role: ChannelRole | null | undefined;
  bankGuest: boolean;
}): boolean {
  return !i.bankGuest && i.role === 'admin' && moderatedKind(i.kind);
}

/**
 * The viewer may remove this message as a moderator (someone else's
 * post): a workspace owner/admin anywhere, a channel admin of a team or
 * private channel (`channelAdmin` already says so); a system post only
 * a workspace owner/admin. One's own post is a plain delete, not this.
 */
export function canModerate(
  m: Pick<ChatMessage, 'authorKind' | 'authorId'>,
  i: { userId: string | null; workspaceAdmin: boolean; channelAdmin: boolean }
): boolean {
  if (m.authorKind === 'system') return i.workspaceAdmin;
  const own =
    !!i.userId && m.authorId?.toLowerCase() === i.userId.toLowerCase();
  return !own && (i.workspaceAdmin || i.channelAdmin);
}

/** A deleted message someone other than its author removed. */
export function removedByModerator(
  m: Pick<ChatMessage, 'deletedAt' | 'deletedBy' | 'authorId'>
): boolean {
  return (
    !!m.deletedAt &&
    !!m.deletedBy &&
    m.deletedBy.toLowerCase() !== (m.authorId ?? '').toLowerCase()
  );
}

// ---------- posting timeouts ----------

const HOUR = 3_600_000;
export const RESTRICT_DURATIONS = {
  '1h': HOUR,
  '8h': 8 * HOUR,
  '1d': 24 * HOUR,
  '3d': 72 * HOUR,
  '7d': 168 * HOUR,
  '30d': 720 * HOUR,
} as const;
export type RestrictDuration = keyof typeof RESTRICT_DURATIONS;
export const RESTRICT_DURATION_KEYS = Object.keys(
  RESTRICT_DURATIONS
) as RestrictDuration[];

/** The `until` restrictMember takes for a duration picked now. */
export const restrictUntil = (d: RestrictDuration, now: number): string =>
  new Date(now + RESTRICT_DURATIONS[d]).toISOString();

/**
 * A post_blocked_until as a Date, in Postgres's text form
 * ("2026-10-30 10:00:01+00") as well as ISO; null when unreadable.
 */
export function restrictionEnd(
  postBlockedUntil: string | null | undefined
): Date | null {
  if (!postBlockedUntil) return null;
  const t = Date.parse(
    postBlockedUntil.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')
  );
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The time a block ends while it is still in force, else null. */
export function activeRestriction(
  postBlockedUntil: string | null | undefined,
  now: number
): string | null {
  const end = restrictionEnd(postBlockedUntil);
  return end && end.getTime() > now ? (postBlockedUntil as string) : null;
}

/**
 * The members panel offers "Restrict posting" on this member: a team or
 * private channel, the viewer a channel admin or workspace owner/admin,
 * the member not the viewer and not a workspace owner/admin, and a
 * channel admin who is not a workspace owner/admin restricts only
 * non-admin members.
 */
export function canRestrictMember(i: {
  kind: ChannelKind;
  viewerId: string | null;
  viewerWorkspaceAdmin: boolean;
  viewerChannelAdmin: boolean;
  memberId: string;
  memberRole: ChannelRole;
  memberWorkspaceAdmin: boolean;
}): boolean {
  if (!moderatedKind(i.kind)) return false;
  if (!i.viewerWorkspaceAdmin && !i.viewerChannelAdmin) return false;
  if (i.viewerId && i.memberId.toLowerCase() === i.viewerId.toLowerCase())
    return false;
  if (i.memberWorkspaceAdmin) return false;
  return i.viewerWorkspaceAdmin || i.memberRole !== 'admin';
}
