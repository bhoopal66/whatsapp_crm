import type { Contact } from '@/types';
import {
  assigneesByContact,
  chatTagsByContact,
  type ChatTagIds,
} from '@/lib/contacts/chat-tag-column';
import { phoneSearchDigits } from '@/lib/contacts/phone-search';
import { escapeIlike, sanitizeContactSearch } from '@/lib/contacts/search';
import type { SearchHit } from '@/lib/contacts/fuzzy-search';

/**
 * The Contacts list (/contacts and /team-contacts) as one round trip and
 * one session-cache entry per view. Pure, so the key and the query's
 * shape are tested without a browser.
 */

/**
 * The contact columns plus, embedded on the conversations FK, the
 * conversation fields the Chat tag and Assigned to columns read. The
 * embed used to be a second request that waited on the first (~0.5 s
 * through the tunnel). It is a plain (not `!inner`) embed, so it
 * neither filters contacts nor changes `count: 'exact'`, and RLS
 * decides which conversations each caller gets, as the separate read
 * did.
 * Accepted trade-off: an error on the embed now fails the whole read,
 * where the separate request only left those two columns blank.
 */
export const CONTACT_LIST_SELECT =
  '*, conversations(contact_id, chat_tag_id, chat_sub_tag_id, assigned_agent_id)';

/** Oldest conversation first: `chatTagsByContact` prefers it. */
export const CONTACT_LIST_CONVERSATION_ORDER = {
  column: 'created_at',
  options: { ascending: true, referencedTable: 'conversations' },
} as const;

/** The only sort the list has (newest first); named in the key. */
export const CONTACT_LIST_SORT = 'created_at.desc';

export interface ContactListView {
  teamView: boolean;
  /** Set when the list is narrowed to contacts this user created. */
  personalOnlyUserId: string | null;
  /** The search term as queried (after the typing pause). */
  search: string;
  /** The chat-tag filter's ids, in any order. */
  chatTagIds: readonly string[];
  page: number;
}

/**
 * The session-cache question for one view of the list: every input
 * that changes the answer, so two views never share an entry.
 */
export function contactListQuestion(view: ContactListView): string {
  return (
    'contacts:list:' +
    JSON.stringify({
      team: view.teamView,
      own: view.personalOnlyUserId,
      q: view.search.trim(),
      tags: [...view.chatTagIds].sort(),
      sort: CONTACT_LIST_SORT,
      page: view.page,
    })
  );
}

/** Prefix of every list view's question, for invalidation after edits. */
export const CONTACT_LIST_QUESTION_PREFIX = 'contacts:list:';

/** What the list renders per contact. */
export interface ContactListRow extends Contact {
  /** The chat tag ids on the contact's conversation, kept raw so that
   *  loading the tag DEFINITIONS (names/colours) does not re-run the
   *  contact query — they are resolved against the tree at render. */
  chatTags: ChatTagIds | null;
  /** Auth user id the contact's chat is assigned to, if any. */
  assignedTo: string | null;
  /** Set by a close-match search: not an exact match for the term. */
  closeMatch?: boolean;
}

export type EmbeddedConversation = ChatTagIds & {
  contact_id: string;
  assigned_agent_id: string | null;
};

export type ContactWithConversations = Contact & {
  conversations?: EmbeddedConversation[] | null;
};

/**
 * Rows as the list renders them, from contacts read with
 * `CONTACT_LIST_SELECT`. The embed is stripped, so a row handed to the
 * edit form carries only contact columns.
 */
export function toContactListRows(
  rows: readonly ContactWithConversations[]
): ContactListRow[] {
  const convs = rows.flatMap((r) => r.conversations ?? []);
  const tags = chatTagsByContact(convs);
  const assignees = assigneesByContact(convs);
  return rows.map((row) => {
    const { conversations: _embedded, ...contact } = row;
    void _embedded;
    return {
      ...(contact as Contact),
      chatTags: tags.get(row.id) ?? null,
      assignedTo: assignees.get(row.id) ?? null,
    };
  });
}

/** The PostgREST builder calls the plain (no tag filter) list makes. */
export interface ContactListQueryBuilder<Q> {
  select(columns: string, options: { count: 'exact' }): Q;
}
export interface ContactListQuery<Q> {
  order(
    column: string,
    options: { ascending: boolean; referencedTable?: string }
  ): Q;
  range(from: number, to: number): Q;
  eq(column: string, value: string): Q;
  or(filter: string): Q;
}

/**
 * `name|phone|email ilike %term%`, plus `phone_normalized like %digits%`
 * for a term of digits (`588336503` finds `+971 58 833 6503`), or null
 * for no search. The term is stripped of `or=(…)` syntax first.
 */
export function contactSearchFilter(term: string): string | null {
  const t = sanitizeContactSearch(term);
  if (!t) return null;
  const like = `%${escapeIlike(t)}%`;
  const parts = [
    `name.ilike.${like}`,
    `phone.ilike.${like}`,
    `email.ilike.${like}`,
  ];
  const digits = phoneSearchDigits(t);
  if (digits) parts.push(`phone_normalized.like.%${digits}%`);
  return parts.join(',');
}

/**
 * The plain list's single request: one page of contacts, newest first,
 * with its exact count and its conversations embedded.
 */
export function buildContactListQuery<Q extends ContactListQuery<Q>>(
  table: ContactListQueryBuilder<Q>,
  view: Pick<ContactListView, 'personalOnlyUserId' | 'search' | 'page'>,
  pageSize: number
): Q {
  const from = view.page * pageSize;
  let query = table
    .select(CONTACT_LIST_SELECT, { count: 'exact' })
    .order('created_at', { ascending: false })
    .order(
      CONTACT_LIST_CONVERSATION_ORDER.column,
      CONTACT_LIST_CONVERSATION_ORDER.options
    )
    .range(from, from + pageSize - 1);
  if (view.personalOnlyUserId) {
    query = query.eq('user_id', view.personalOnlyUserId);
  }
  const search = contactSearchFilter(view.search);
  if (search) query = query.or(search);
  return query;
}

/**
 * Keep the hits whose contact is in every narrowing set (personal
 * owner, chat-tag filter), in the RPC's rank order. A null set means
 * that narrowing does not apply.
 */
export function narrowHits(
  hits: readonly SearchHit[],
  allowed: readonly (ReadonlySet<string> | null)[]
): SearchHit[] {
  const sets = allowed.filter((s): s is ReadonlySet<string> => s !== null);
  return hits.filter((h) => sets.every((s) => s.has(h.contactId)));
}

/** One page of ranked hits, plus how many hits there are in all. */
export function pageOfHits(
  hits: readonly SearchHit[],
  from: number,
  size: number
): { hits: SearchHit[]; total: number } {
  return { hits: hits.slice(from, from + size), total: hits.length };
}

/** Id of the row the "Close matches" divider goes above, or null. */
export function firstCloseMatchId(
  rows: readonly { id: string; closeMatch?: boolean }[]
): string | null {
  return rows.find((r) => r.closeMatch)?.id ?? null;
}
