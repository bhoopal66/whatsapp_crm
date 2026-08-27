import { hasMinRole, type AccountRole } from './roles';

/**
 * Client-side mirror of the `can_view_conversation` SQL function
 * (migration 042).
 *
 * The database is the enforcement point: the inbox queries PostgREST
 * directly, so RLS is what actually decides which rows come back, and
 * Realtime replays the same policies per subscriber. Nothing here can
 * grant access.
 *
 * What it is for is the UI's own decisions — whether to offer an
 * action, how to label a thread, whether an empty list means "no
 * chats" or "none of yours". Those need the same rule, and re-deriving
 * it inline at each call site is how the two drift apart.
 *
 * Keep in lockstep with migration 042.
 */
export function canViewConversation(
  role: AccountRole | null,
  userId: string | null,
  conversation: { ownerId: string | null; assignedId: string | null },
): boolean {
  // Unknown role or unknown user: fail closed. Both mean the profile
  // has not resolved yet, and flashing a chat into view only to remove
  // it is worse than a moment of emptiness.
  if (!role || !userId) return false;

  // Admins and owners triage the whole account — including inbound
  // chats from unknown numbers, which land owned by whoever connected
  // the WhatsApp channel.
  if (hasMinRole(role, 'admin')) return true;

  return conversation.ownerId === userId || conversation.assignedId === userId;
}

/**
 * May this role hand a conversation to someone *else*?
 *
 * Admin-only, because assignment is what grants visibility: giving a
 * chat away decides who can read the customer's history. Members may
 * still self-assign or release — that is the "take over from the AI"
 * button — which the assignment trigger in migration 042 permits and
 * this predicate deliberately does not describe.
 */
export function canAssignToOthers(role: AccountRole | null): boolean {
  return !!role && hasMinRole(role, 'admin');
}

/**
 * Client-side mirror of the `can_view_contact` SQL function
 * (migration 043).
 *
 * Same standing as {@link canViewConversation}: the database decides,
 * this exists so the UI can reason about the same rule without
 * re-deriving it inline.
 *
 * The `handlesChat` flag is the caller's answer to "does this user own
 * or hold the conversation with this contact?" — the UI usually knows
 * that already from the conversation it is rendering, and it is not
 * worth a second round trip to re-ask.
 *
 * Note the OR: a contact you created stays yours even with no chat
 * against it, which is what makes "add a contact, then message them"
 * work.
 */
export function canViewContact(
  role: AccountRole | null,
  userId: string | null,
  contact: { creatorId: string | null; handlesChat?: boolean },
): boolean {
  if (!role || !userId) return false;
  if (hasMinRole(role, 'admin')) return true;
  return contact.creatorId === userId || contact.handlesChat === true;
}
