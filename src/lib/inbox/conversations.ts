import { resolveListHandler } from '@/lib/inbox/handler';
import type { Conversation } from '@/types';

/**
 * Conversation select that embeds the contact. Contact tags are retired
 * (chat tags are the only tag system), so no tag join rides along.
 */
export const CONVERSATION_SELECT = '*, contact:contacts(*)';

/**
 * Kept so every caller of {@link CONVERSATION_SELECT} compiles unchanged:
 * the embedded contact needs no reshaping any more, so a row passes
 * through as it is.
 */
export function normalizeConversation(raw: Conversation): Conversation {
  return raw;
}

export function normalizeConversations(rows: Conversation[]): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filter (issue
 * #272). A null `company` is a no-op, so the default (no filter) always
 * matches.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { company }: ContactFilters
): boolean {
  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

/**
 * Sentinel for "nobody holds this chat" in the Inbox's by-agent
 * filter. A real value is a user id (a UUID), so the two can share one
 * piece of state without colliding.
 */
export const UNASSIGNED = 'unassigned';

/**
 * Who the Inbox list is currently narrowed to: a user id, {@link
 * UNASSIGNED}, or `null` for no filter.
 */
export type AssigneeFilter = string | typeof UNASSIGNED | null;

/**
 * Whether a conversation passes the Inbox's by-agent filter.
 *
 * Picking a teammate asks "what is this person responsible for", and
 * that is broader than `assigned_agent_id`: a chat nobody ever pressed
 * Assign on still belongs to its owner (`user_id`), which is the agent
 * who started it, or — on an inbound chat — whoever connected the
 * WhatsApp channel. Filtering on the assignment column alone dropped
 * every one of those from the by-agent view while the Inbox header was
 * plainly naming an owner (see `resolveListHandler`).
 *
 * {@link UNASSIGNED} keeps its narrower meaning — nobody has *taken*
 * the chat — because that option is the triage queue, and an owner
 * inherited from the channel is exactly the case it needs to surface.
 * The two therefore overlap: an owned-but-unassigned chat answers to
 * both its owner's name and to Unassigned.
 *
 * A `null` filter is a no-op, so the default (no filter) matches
 * every row.
 */
export function matchesAssignee(
  conversation: Conversation,
  filter: AssigneeFilter
): boolean {
  if (filter === null) return true;
  if (filter === UNASSIGNED)
    return (conversation.assigned_agent_id ?? null) === null;
  return resolveListHandler(conversation)?.userId === filter;
}
