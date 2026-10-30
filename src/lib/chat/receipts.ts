/**
 * Seen-by receipts (156) from members' read marks. Shown only where the
 * list is small enough to mean something.
 */
import type { ChannelKind, ChannelMember, ChatMessage } from './types';

export const RECEIPTS_MAX_MEMBERS = 20;

export function seenBy(i: {
  createdAt: string;
  authorId: string | null;
  members: readonly { userId: string; lastReadAt: string | null }[];
}): { seen: string[]; unseen: string[] } {
  const at = Date.parse(i.createdAt);
  const seen: string[] = [];
  const unseen: string[] = [];
  for (const m of i.members) {
    if (m.userId === i.authorId) continue;
    const read = m.lastReadAt === null ? NaN : Date.parse(m.lastReadAt);
    (read >= at ? seen : unseen).push(m.userId);
  }
  return { seen, unseen };
}

export function showsReceipts(kind: ChannelKind, memberCount: number): boolean {
  if (kind === 'dm') return true;
  if (kind === 'team' || kind === 'private')
    return memberCount <= RECEIPTS_MAX_MEMBERS;
  return false;
}

type TimelineMessage = Pick<
  ChatMessage,
  'id' | 'threadRootId' | 'authorKind' | 'authorId' | 'createdAt'
> &
  Partial<Pick<ChatMessage, 'deletedAt' | 'erasedAt'>>;

const sameUser = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
const gone = (m: TimelineMessage) => !!m.deletedAt || !!m.erasedAt;
const instant = (s: string | null | undefined) =>
  s ? Date.parse(s) : Number.NaN;

/**
 * The instant the unread badge counts from: 091's chat_unread_counts uses
 * greatest(last_read_at, joined_at), and Postgres's greatest() skips
 * NULLs. Null with no membership row (nothing to count from).
 */
export function unreadSince(
  m: Pick<ChannelMember, 'lastReadAt' | 'joinedAt'> | null | undefined
): string | null {
  if (!m) return null;
  const read = instant(m.lastReadAt);
  const joined = instant(m.joinedAt);
  if (Number.isNaN(read)) return Number.isNaN(joined) ? null : m.joinedAt;
  if (Number.isNaN(joined)) return m.lastReadAt;
  return read >= joined ? m.lastReadAt : m.joinedAt;
}

/**
 * Where the "New messages" divider goes: the first top-level message
 * after `since` that the unread badge counted (chat_unread_counts' rule:
 * not the viewer's own, not deleted or erased; a system post counts).
 * `until` caps it to messages already there when the channel opened, so
 * one arriving while the viewer watches never adds a divider. Null
 * `since`: no divider.
 */
export function firstUnreadId(
  messages: readonly TimelineMessage[],
  since: string | null,
  selfId: string | null,
  until?: string | null
): string | null {
  const from = instant(since);
  if (Number.isNaN(from)) return null;
  const to = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
  for (const m of messages) {
    if (m.threadRootId !== null || gone(m)) continue;
    if (sameUser(m.authorId, selfId)) continue;
    const at = Date.parse(m.createdAt);
    if (at > from && at <= to) return m.id;
  }
  return null;
}

/** The viewer's newest top-level message that still has a body: where "Seen by" goes. */
export function lastOwnTopLevelId(
  messages: readonly TimelineMessage[],
  selfId: string | null
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.threadRootId !== null || m.authorKind !== 'user' || gone(m)) continue;
    if (sameUser(m.authorId, selfId)) return m.id;
  }
  return null;
}

export type ReceiptLabel = 'none' | 'sent' | 'seen' | 'seenBy';

/**
 * What the receipt line says. A 1:1 DM has no one to name: "Seen" or
 * "Sent". Anywhere else, "Seen by N" once anyone has, "Sent" before.
 */
export function receiptLabel(i: {
  kind: ChannelKind;
  memberCount: number;
  seenCount: number;
}): ReceiptLabel {
  if (!showsReceipts(i.kind, i.memberCount)) return 'none';
  if (i.kind === 'dm' && i.memberCount <= 2)
    return i.seenCount > 0 ? 'seen' : 'sent';
  return i.seenCount > 0 ? 'seenBy' : 'sent';
}

export interface MemberEvent {
  type: 'insert' | 'update' | 'delete';
  member: Pick<ChannelMember, 'channelId' | 'userId'> & Partial<ChannelMember>;
}

/**
 * One channel's member list with a realtime member event applied; the
 * same array when the event is for another channel or changes nothing.
 * A DELETE carries only the key, so an event for a row not held adds it
 * only when it is a whole row.
 */
export function applyMemberEvent(
  members: readonly ChannelMember[],
  channelId: string,
  e: MemberEvent
): readonly ChannelMember[] {
  if (e.member.channelId !== channelId) return members;
  const at = members.findIndex((m) => m.userId === e.member.userId);
  if (e.type === 'delete')
    return at < 0 ? members : members.filter((_, i) => i !== at);
  if (at >= 0) {
    const next = members.slice();
    next[at] = { ...members[at], ...e.member };
    return next;
  }
  if (e.member.joinedAt === undefined || e.member.role === undefined)
    return members;
  return [
    ...members,
    {
      channelId: e.member.channelId,
      userId: e.member.userId,
      role: e.member.role,
      joinedAt: e.member.joinedAt,
      lastReadAt: e.member.lastReadAt ?? null,
      muted: e.member.muted ?? false,
    },
  ];
}
