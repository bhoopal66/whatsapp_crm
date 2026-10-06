import { resolveListHandler } from '@/lib/inbox/handler';
import type { Conversation, Contact, Tag } from '@/types';

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  '*, contact:contacts(*, contact_tags(tags(*)))';

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, 'contact'> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[]
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

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
