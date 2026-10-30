/**
 * Team-chat moderation (160), the pure pieces the UI needs: who may
 * remove someone else's message, the reason the database requires for
 * it, and posting timeouts. The database decides; these only choose
 * what to offer.
 */
import type {
  ChannelKind,
  ChannelRestriction,
  ChannelRole,
  ChatMessage,
} from './types';

/** chat_delete_message / chat_restrict_member: a reason of 5–500 characters. */
export const MODERATION_REASON_MIN = 5;
export const MODERATION_REASON_MAX = 500;

/** chat_assert_reason trims exactly these: btrim(p, E' \t\r\n'). */
const trimReason = (s: string): string =>
  s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

/** Length after that trim, as Postgres's char_length sees it (code points). */
export const reasonLength = (s: string): number => [...trimReason(s)].length;

/**
 * chat_assert_reason: at least 5 non-whitespace characters and at most
 * 500 after the trim. `\s` also covers NBSP, which Postgres's
 * [[:space:]] may not: the client errs on the strict side.
 */
export function moderationReasonValid(s: string): boolean {
  const solid = [...s.replace(/\s/g, '')].length;
  return (
    solid >= MODERATION_REASON_MIN && reasonLength(s) <= MODERATION_REASON_MAX
  );
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
  // 5 minutes short: the database refuses an end more than 30 days ahead
  // by its own clock, so a fast device clock must not trip it.
  '30d': 720 * HOUR - 5 * 60_000,
} as const;
export type RestrictDuration = keyof typeof RESTRICT_DURATIONS;
export const RESTRICT_DURATION_KEYS = Object.keys(
  RESTRICT_DURATIONS
) as RestrictDuration[];

/** The `until` restrictMember takes for a duration picked now. */
export const restrictUntil = (d: RestrictDuration, now: number): string =>
  new Date(now + RESTRICT_DURATIONS[d]).toISOString();

/**
 * A restriction's `until` as a Date, in Postgres's text form
 * ("2026-10-30 10:00:01+00") as well as ISO; null when unreadable.
 */
export function restrictionEnd(until: string | null | undefined): Date | null {
  if (!until) return null;
  const t = Date.parse(until.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The time a block ends while it is still in force, else null. */
export function activeRestriction(
  until: string | null | undefined,
  now: number
): string | null {
  const end = restrictionEnd(until);
  return end && end.getTime() > now ? (until as string) : null;
}

/**
 * One channel's timeouts in force at `now`, lower-cased user id → until.
 * A lifted row (until = the lift time) is left out, as is another
 * channel's row.
 */
export function activeRestrictions(
  rows: readonly ChannelRestriction[],
  channelId: string,
  now: number
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.channelId !== channelId) continue;
    const until = activeRestriction(r.until, now);
    if (until) out.set(r.userId.toLowerCase(), until);
  }
  return out;
}

/**
 * Rows with a realtime INSERT / UPDATE applied: replaces the row for the
 * same channel and person, else appends it. Another channel's row leaves
 * `rows` as it is (same array).
 */
export function upsertRestriction(
  rows: readonly ChannelRestriction[],
  channelId: string,
  r: ChannelRestriction
): readonly ChannelRestriction[] {
  if (r.channelId !== channelId) return rows;
  const user = r.userId.toLowerCase();
  const at = rows.findIndex((x) => x.userId.toLowerCase() === user);
  if (at < 0) return [...rows, r];
  const next = rows.slice();
  next[at] = r;
  return next;
}

/** The soonest end among timeouts in force (ms since epoch), else null. */
export function nextRestrictionEnd(
  active: ReadonlyMap<string, string>
): number | null {
  let soonest: number | null = null;
  for (const until of active.values()) {
    const t = restrictionEnd(until)?.getTime();
    if (t !== undefined && (soonest === null || t < soonest)) soonest = t;
  }
  return soonest;
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

/** The Remove-message dialog's own state: the typed reason, and a removal in flight. */
export interface RemoveDialogState {
  reason: string;
  busy: boolean;
}

export type RemoveDialogEvent =
  | { type: 'edit'; reason: string }
  | { type: 'dismiss' }
  | { type: 'submit' }
  | { type: 'settled'; ok: boolean };

/**
 * One step of the Remove-message dialog. It closes, and forgets the
 * reason, only when the removal succeeded or the person dismissed it;
 * a refused removal keeps the dialog open with the reason as typed.
 * While a removal is in flight nothing else is accepted, so its result
 * always lands in an open dialog.
 */
export function removeDialogStep(
  s: RemoveDialogState,
  e: RemoveDialogEvent
): RemoveDialogState & { close: boolean } {
  const stay = { ...s, close: false };
  const reset = { reason: '', busy: false, close: true };
  switch (e.type) {
    case 'edit':
      return s.busy ? stay : { reason: e.reason, busy: false, close: false };
    case 'dismiss':
      return s.busy ? stay : reset;
    case 'submit':
      return s.busy || !moderationReasonValid(s.reason)
        ? stay
        : { reason: s.reason, busy: true, close: false };
    case 'settled':
      return e.ok ? reset : { reason: s.reason, busy: false, close: false };
  }
}
