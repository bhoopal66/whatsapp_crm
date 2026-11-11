/**
 * Personal chats (migration 191): a chat on a staff member's own
 * scanned WhatsApp carries `personal_owner_id`. RLS shows it to its
 * owner, their team leaders and admins, but only the Team inbox lists
 * other people's: a viewer's own Inbox (and its unread count) holds
 * company chats and their own personal chats.
 */

/** A row's personal-chat owner, as the list and the counts read it. */
export type PersonalChatRow = { personal_owner_id?: string | null };

/**
 * Is this someone else's personal chat? An unknown viewer fails closed:
 * every personal chat counts as someone else's until they are known.
 */
export function isOthersPersonalChat(
  row: PersonalChatRow,
  userId: string | null
): boolean {
  const owner = row.personal_owner_id ?? null;
  return owner !== null && owner !== userId;
}

/**
 * The list query's `or` group for /inbox: company chats plus the
 * viewer's own personal chats ({@link isOthersPersonalChat}'s negation).
 */
export function ownPersonalChatsGroup(userId: string): string {
  return `personal_owner_id.is.null,personal_owner_id.eq.${userId}`;
}
