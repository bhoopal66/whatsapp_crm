import {
  canReceiveCoordinatorShare,
  hasMinRole,
  type AccountRole,
} from './roles';

/**
 * Roles a chat share can grant to (migration 130's
 * `coordinator_share_grants`): a coordinator is a live agent or team
 * leader holding a bank. A viewer, an admin (who sees everything
 * anyway) and a bank guest get nothing from a share.
 */
function shareCanGrant(role: AccountRole): boolean {
  return canReceiveCoordinatorShare(role);
}

/**
 * Client-side mirror of the `can_view_conversation` SQL function
 * (migration 042, extended by 044; 072 removed the number-allocation
 * grant that 060 had added).
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
 * Allocation to a WhatsApp number (060, 071) grants no visibility: it
 * only decides which numbers someone may send from. Keep in lockstep
 * with migrations 042, 044 and 072.
 *
 * `sharedWithMe` is the caller's answer to "is there an open share of
 * this chat to me, under a bank I still hold?" (130's
 * `conversation_coordinator_shares` + `coordinator_banks`). It shows the
 * chat to an agent or team leader only, as `coordinator_share_grants`
 * does. It grants reading and replying, never editing the chat.
 */
export function canViewConversation(
  role: AccountRole | null,
  userId: string | null,
  conversation: {
    ownerId: string | null;
    assignedId: string | null;
    sharedWithMe?: boolean;
  }
): boolean {
  // Unknown role or unknown user: fail closed. Both mean the profile
  // has not resolved yet, and flashing a chat into view only to remove
  // it is worse than a moment of emptiness.
  if (!role || !userId) return false;

  // Admins and owners triage the whole account — including inbound
  // chats from unknown numbers, which land owned by whoever connected
  // the WhatsApp channel.
  if (hasMinRole(role, 'admin')) return true;

  if (conversation.ownerId === userId || conversation.assignedId === userId) {
    return true;
  }
  return conversation.sharedWithMe === true && shareCanGrant(role);
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
 *
 * A chat shared with a coordinator (migration 130) does NOT count here:
 * `can_view_contact` is deliberately unchanged, because it also grants
 * contact edit and delete, notes, tasks, calls and memory. The share's
 * read-only grant is {@link canReadContact}.
 */
export function canViewContact(
  role: AccountRole | null,
  userId: string | null,
  contact: { creatorId: string | null; handlesChat?: boolean }
): boolean {
  if (!role || !userId) return false;
  if (hasMinRole(role, 'admin')) return true;
  return contact.creatorId === userId || contact.handlesChat === true;
}

/**
 * May this viewer READ the contact? {@link canViewContact}, plus
 * migration 130's `contacts_coordinator_select`: a coordinator (agent or
 * team leader) with a chat of this contact shared to them reads the
 * contact, and nothing more. Editing stays {@link canViewContact}.
 *
 * `sharedWithMe` is "is one of this contact's chats shared with me?"
 * (`coordinator_share_grants_contact`).
 */
export function canReadContact(
  role: AccountRole | null,
  userId: string | null,
  contact: {
    creatorId: string | null;
    handlesChat?: boolean;
    sharedWithMe?: boolean;
  }
): boolean {
  if (canViewContact(role, userId, contact)) return true;
  if (!role || !userId) return false;
  return contact.sharedWithMe === true && shareCanGrant(role);
}

/**
 * Does this viewer's inbox list mix chats that belong to different
 * people?
 *
 * Same standing as {@link canViewConversation}: advisory, for the UI's
 * own decisions. Here the decision is whether to show *who holds* each
 * thread and offer the by-agent filter. For a plain agent every row in
 * the list is already theirs, so the column would be a name repeated
 * down the page; for anyone triaging other people's work it is the
 * first thing they need to see.
 *
 * `teamView` is the /team-inbox vs /inbox distinction. A team leader
 * sees their whole team through RLS (migration 044), but their
 * personal inbox narrows back to their own threads — so only the team
 * view mixes owners for them. Admins and owners triage the whole
 * account on both routes.
 */
export function viewsOthersConversations(
  role: AccountRole | null,
  teamView: boolean
): boolean {
  if (!role) return false;
  if (hasMinRole(role, 'admin')) return true;
  return role === 'team_leader' && teamView;
}
