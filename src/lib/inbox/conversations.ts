import { resolveListHandler } from '@/lib/inbox/handler';
import type { Contact, Conversation } from '@/types';

/**
 * Conversation select that embeds the contact. Contact tags are retired
 * (chat tags are the only tag system), so no tag join rides along.
 *
 * The full row: for the conversation that is *open* (the thread, its
 * header, the AI banner's held draft and hand-off summary, the contact
 * panel). The list reads {@link CONVERSATION_LIST_SELECT} instead.
 */
export const CONVERSATION_SELECT = '*, contact:contacts(*)';

/**
 * The conversation columns the Inbox list reads: the row (preview,
 * time, unread badge, number and campaign labels, tag pill, Important
 * pin, handler, the Smart insights colours, chips, filters and pins
 * until handled), the filters it re-applies client-side (chat tag,
 * by-agent, Campaign inbox), the sort and the keyset cursor, and the
 * delta-resync watermark (`updated_at`).
 *
 * Everything else stays off the list on purpose: behind the tunnel a
 * page of 50 rows is one slow response, and the wide AI columns
 * (`ai_pending_draft`, `ai_handoff_summary`, `ai_last_outcome_detail`)
 * are only read by the open thread, which loads the full row
 * ({@link CONVERSATION_SELECT}) when a chat is opened. A column added
 * here must be read by something on the list; one read there but not
 * listed here is a type error, because the list holds
 * {@link ConversationListItem}s.
 */
export const CONVERSATION_LIST_COLUMNS = [
  'id',
  'user_id',
  'assigned_agent_id',
  'last_message_text',
  'last_message_at',
  'unread_count',
  'updated_at',
  'channel_id',
  'send_channel_id',
  'chat_tag_id',
  'chat_sub_tag_id',
  'campaign_broadcast_id',
  'human_engaged_at',
  'ai_autoreply_disabled',
  'ai_reply_count',
  'ai_attention_at',
  'insight_intent',
  'insight_urgency',
  'insight_lead_temp',
  'insight_upset',
  'insight_wants_human',
  'insight_priority',
  'insight_at',
  'insight_sentiment',
  'insight_objections',
  'insight_needs_reply',
  'insight_callback',
  'insight_attention_at',
  'insight_attention_reason',
  'personal_owner_id',
  'inbox_department',
] as const satisfies readonly (keyof Conversation)[];

/**
 * The contact columns a list row reads: its name, number and photo, the
 * company filter, and the id (the avatar lookup, "Open customer").
 */
export const CONTACT_LIST_COLUMNS = [
  'id',
  'name',
  'phone',
  'company',
  'avatar_url',
] as const satisfies readonly (keyof Contact)[];

/**
 * The Inbox list's select: {@link CONVERSATION_LIST_COLUMNS} plus a
 * narrow contact embed. Spelled out rather than joined from the arrays
 * because supabase-js parses a select string at the type level and a
 * computed `string` comes back typed as an error; `conversations.test.ts`
 * pins it to the two lists.
 */
export const CONVERSATION_LIST_SELECT =
  'id,user_id,assigned_agent_id,last_message_text,last_message_at,unread_count,updated_at,channel_id,send_channel_id,chat_tag_id,chat_sub_tag_id,campaign_broadcast_id,human_engaged_at,ai_autoreply_disabled,ai_reply_count,ai_attention_at,insight_intent,insight_urgency,insight_lead_temp,insight_upset,insight_wants_human,insight_priority,insight_at,insight_sentiment,insight_objections,insight_needs_reply,insight_callback,insight_attention_at,insight_attention_reason,personal_owner_id,inbox_department,contact:contacts(id,name,phone,company,avatar_url)';

export type ConversationListContact = Pick<
  Contact,
  (typeof CONTACT_LIST_COLUMNS)[number]
>;

/**
 * A row as the Inbox list holds it. A full {@link Conversation} (a
 * realtime payload, a hydrated row) is assignable to it; the reverse is
 * not, so the open thread cannot be handed a list row by mistake.
 */
export type ConversationListItem = Pick<
  Conversation,
  (typeof CONVERSATION_LIST_COLUMNS)[number]
> & {
  contact?: ConversationListContact | null;
};

/**
 * Kept so every caller of {@link CONVERSATION_SELECT} compiles unchanged:
 * the embedded contact needs no reshaping any more, so a row passes
 * through as it is.
 */
export function normalizeConversation(raw: Conversation): Conversation {
  return raw;
}

/**
 * A list row as supabase-js types it from {@link CONVERSATION_LIST_SELECT}.
 * Without generated schema types it cannot know `contact` is a
 * many-to-one embed, so it types it as an array; PostgREST sends the
 * object (or null).
 */
type RawConversationListItem = Omit<ConversationListItem, 'contact'> & {
  contact?: ConversationListContact | ConversationListContact[] | null;
};

/** A page of list rows as the list query returns them. */
export function normalizeConversations(
  rows: RawConversationListItem[]
): ConversationListItem[] {
  return rows.map(({ contact, ...row }) => ({
    ...row,
    contact: Array.isArray(contact) ? (contact[0] ?? null) : contact,
  }));
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
  conversation: { contact?: Pick<Contact, 'company'> | null },
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
  conversation: Pick<Conversation, 'user_id'> & {
    assigned_agent_id?: string | null;
  },
  filter: AssigneeFilter
): boolean {
  if (filter === null) return true;
  if (filter === UNASSIGNED)
    return (conversation.assigned_agent_id ?? null) === null;
  return resolveListHandler(conversation)?.userId === filter;
}
