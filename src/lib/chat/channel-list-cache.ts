import type { MemberEvent } from './receipts';
import type { ChannelWithMembership } from './types';

/**
 * Session-cache questions (`lib/session-cache.ts`) for the /chat
 * workspace: the channel list (archived included) and the unread
 * counts. Keyed per account and user by `sessionKey`.
 */
export const CHAT_CHANNELS_QUESTION = 'chat:channels';
export const CHAT_UNREAD_QUESTION = 'chat:unread';

/**
 * The channel list with a realtime member event applied locally, or null
 * when the list must be reloaded instead.
 *
 * Opening a channel marks it read, which writes the viewer's own member
 * row; its realtime echo used to reload the whole list (a round trip of
 * ~0.5 s) for a change the list already implies. So an UPDATE of the
 * viewer's own row that differs from the held membership only in
 * `lastReadAt` is patched in place (the same array when nothing
 * changed). Anything else — another person's row, an insert or delete,
 * a role or mute change, a channel not held — returns null: today's
 * reload.
 */
export function patchOwnReadMark(
  channels: ChannelWithMembership[],
  e: MemberEvent,
  userId: string
): ChannelWithMembership[] | null {
  if (e.type !== 'update') return null;
  const m = e.member;
  if (m.userId.toLowerCase() !== userId.toLowerCase()) return null;
  const at = channels.findIndex((c) => c.id === m.channelId);
  const held = at < 0 ? null : channels[at].membership;
  if (!held) return null;
  if (
    m.role !== held.role ||
    m.joinedAt !== held.joinedAt ||
    m.muted !== held.muted ||
    m.lastReadAt === undefined
  )
    return null;
  if (m.lastReadAt === held.lastReadAt) return channels;
  const next = channels.slice();
  next[at] = {
    ...channels[at],
    membership: { ...held, lastReadAt: m.lastReadAt },
  };
  return next;
}
