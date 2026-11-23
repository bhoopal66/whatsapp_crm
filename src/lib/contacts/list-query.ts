import type { Contact } from '@/types';
import {
  assigneesByContact,
  chatTagsByContact,
  type ChatTagIds,
} from '@/lib/contacts/chat-tag-column';
import { phoneSearchDigits } from '@/lib/contacts/phone-search';
import { escapeIlike, sanitizeContactSearch } from '@/lib/contacts/search';
import type { SearchHit } from '@/lib/contacts/fuzzy-search';
import {
  DEFAULT_CONTACT_SORT,
  effectiveContactSort,
  type ContactSort,
} from '@/lib/contacts/sort';
import {
  LEAD_SOURCE_COLUMN_AVAILABLE,
  parseLeadSources,
} from '@/lib/contacts/lead-source';

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
 * `personal_owner_id` and `last_message_at` feed Assigned to and Last
 * activity, which read company chats only, as migration 257's sort does.
 */
export const CONTACT_LIST_SELECT =
  '*, conversations(contact_id, chat_tag_id, chat_sub_tag_id, assigned_agent_id, personal_owner_id, last_message_at)';

/** Oldest conversation first: `chatTagsByContact` prefers it. */
export const CONTACT_LIST_CONVERSATION_ORDER = {
  column: 'created_at',
  options: { ascending: true, referencedTable: 'conversations' },
} as const;

/** The default sort (newest first); named in the key. */
export const CONTACT_LIST_SORT = 'created_at.desc';

/**
 * The sort as the cache key names it: `created_at.desc`, `name.asc`,
 * `owner.asc`, `assignee.desc`, `activity.desc`.
 */
export function contactSortLabel(sort: ContactSort): string {
  const column = sort.sort === 'created' ? 'created_at' : sort.sort;
  return `${column}.${sort.dir}`;
}

export interface ContactListView {
  teamView: boolean;
  /** Set when the list is narrowed to contacts this user created. */
  personalOnlyUserId: string | null;
  /** The search term as queried (after the typing pause). */
  search: string;
  /** The chat-tag filter's ids, in any order. */
  chatTagIds: readonly string[];
  /** Defaults to newest first. */
  sort?: ContactSort;
  /** Lead sources to keep (any of); empty = all. */
  sources?: readonly string[];
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
      sort: contactSortLabel(view.sort ?? DEFAULT_CONTACT_SORT),
      src: parseLeadSources(view.sources ?? []),
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
  /** Auth user id the contact's company chat is assigned to, if any. */
  assignedTo: string | null;
  /** The newest message in the contact's company chat (ISO), if any. */
  lastActivityAt: string | null;
  /** Set by a close-match search: not an exact match for the term. */
  closeMatch?: boolean;
}

export type EmbeddedConversation = ChatTagIds & {
  contact_id: string;
  assigned_agent_id: string | null;
  /** Set on a personal chat (migration 191); absent on older reads. */
  personal_owner_id?: string | null;
  last_message_at?: string | null;
};

export type ContactWithConversations = Contact & {
  conversations?: EmbeddedConversation[] | null;
};

/**
 * contact id → the newest `last_message_at` over the given chats, for
 * the "Last activity" column. A contact with no message is absent.
 */
export function lastActivityByContact(
  rows: readonly { contact_id: string; last_message_at?: string | null }[]
): Map<string, string> {
  const byContact = new Map<string, string>();
  for (const row of rows) {
    if (!row.last_message_at) continue;
    const current = byContact.get(row.contact_id);
    if (!current || Date.parse(row.last_message_at) > Date.parse(current)) {
      byContact.set(row.contact_id, row.last_message_at);
    }
  }
  return byContact;
}

/**
 * Rows as the list renders them, from contacts read with
 * `CONTACT_LIST_SELECT`. The embed is stripped, so a row handed to the
 * edit form carries only contact columns. Assigned to and Last activity
 * read company chats only (personal chats, migration 191, are someone's
 * own line), the same rule migration 257 sorts by.
 */
export function toContactListRows(
  rows: readonly ContactWithConversations[]
): ContactListRow[] {
  const convs = rows.flatMap((r) => r.conversations ?? []);
  const company = convs.filter((c) => !c.personal_owner_id);
  const tags = chatTagsByContact(convs);
  const assignees = assigneesByContact(company);
  const activity = lastActivityByContact(company);
  return rows.map((row) => {
    const { conversations: _embedded, ...contact } = row;
    void _embedded;
    return {
      ...(contact as Contact),
      chatTags: tags.get(row.id) ?? null,
      assignedTo: assignees.get(row.id) ?? null,
      lastActivityAt: activity.get(row.id) ?? null,
    };
  });
}

/**
 * `rows` in the order of `ids` (a page the server ordered), dropping
 * ids with no row (a contact deleted between the two reads).
 */
export function inIdOrder<T extends { id: string }>(
  rows: readonly T[],
  ids: readonly string[]
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => !!r);
}

/** The PostgREST builder calls the plain (no tag filter) list makes. */
export interface ContactListQueryBuilder<Q> {
  select(columns: string, options: { count: 'exact' }): Q;
}
export interface ContactListQuery<Q> {
  order(
    column: string,
    options: {
      ascending: boolean;
      nullsFirst?: boolean;
      referencedTable?: string;
    }
  ): Q;
  range(from: number, to: number): Q;
  eq(column: string, value: string): Q;
  in(column: string, values: string[]): Q;
  or(filter: string): Q;
}

/**
 * `name|phone|email ilike %term%`, plus `phone_normalized like %digits%`
 * for a term of digits (`588336503` finds `+971 58 833 6503`), or null
 * for no search. The term is stripped of `or=(…)` syntax first.
 */
export function contactSearchFilter(term: string): string | null {
  const terms = contactSearchTerms(term);
  if (!terms) return null;
  const { like, digits } = terms;
  const parts = [
    `name.ilike.${like}`,
    `phone.ilike.${like}`,
    `email.ilike.${like}`,
  ];
  if (digits) parts.push(`phone_normalized.like.%${digits}%`);
  return parts.join(',');
}

/**
 * The plain search as its two parts: the escaped `%term%` ILIKE pattern
 * (name, phone, email) and the phone digits, or null for no search.
 * `contactSearchFilter` and migration 257's RPC arguments both come from
 * here, so the sorted list matches exactly what the plain one matches.
 */
export function contactSearchTerms(
  term: string
): { like: string; digits: string | null } | null {
  const t = sanitizeContactSearch(term);
  if (!t) return null;
  return { like: `%${escapeIlike(t)}%`, digits: phoneSearchDigits(t) };
}

/**
 * The plain list's single request: one page of contacts, newest first,
 * with its exact count and its conversations embedded.
 */
export function buildContactListQuery<Q extends ContactListQuery<Q>>(
  table: ContactListQueryBuilder<Q>,
  view: Pick<ContactListView, 'personalOnlyUserId' | 'search' | 'page'> & {
    sort?: ContactSort;
    sources?: readonly string[];
  },
  pageSize: number
): Q {
  const from = view.page * pageSize;
  // Owner / assignee / activity are the RPC's (migration 257); reaching
  // this query with one means the RPC is missing: the default order.
  const sort = effectiveContactSort(view.sort ?? DEFAULT_CONTACT_SORT, false);
  const ascending = sort.dir === 'asc';
  let ordered: Q = table.select(CONTACT_LIST_SELECT, { count: 'exact' });
  // Names first (blank last), then newest first, then id: stable pages.
  if (sort.sort === 'name') {
    ordered = ordered.order('name', { ascending, nullsFirst: false });
    ordered = ordered.order('created_at', { ascending: false });
  } else {
    ordered = ordered.order('created_at', { ascending });
  }
  // id last, so rows that tie on created_at never swap across pages
  // (compareContactRows and migration 257 end on it too).
  ordered = ordered.order('id', { ascending: false });
  let query = ordered
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
  const sources = parseLeadSources(view.sources ?? []);
  if (LEAD_SOURCE_COLUMN_AVAILABLE && sources.length > 0) {
    query = query.in('lead_source', sources);
  }
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
