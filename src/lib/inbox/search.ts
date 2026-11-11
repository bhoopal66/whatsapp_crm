/**
 * The Inbox search box, on the server and on the rows held.
 *
 * A search used to filter only the rows already loaded, so an older chat
 * beyond the first pages could not be found at all. Now the typed term is
 * first turned into contacts (migration 193's close-match
 * `search_contacts`, else the plain ilike filter), and the list runs two
 * reads under the same view narrowing: chats of those contacts, and chats
 * whose last message holds the term (`mergeSearchRows` joins them).
 * The same match is re-applied to the held rows, which realtime and
 * deltas keep changing.
 */

import { phoneDigits, phoneSearchDigits } from '@/lib/contacts/phone-search';
import { sanitizeContactSearch } from '@/lib/contacts/search';
import type { SearchHit } from '@/lib/contacts/fuzzy-search';

/** Pause after typing before asking the server. */
export const INBOX_SEARCH_DEBOUNCE_MS = 300;

/**
 * Contacts asked for, and chats listed, per search: one page and no
 * further pages (a search narrows by typing more, not by scrolling).
 */
export const INBOX_SEARCH_LIMIT = 100;

/**
 * Contacts the RPC is asked for, before the view (own chats, team,
 * department, campaign, tag) narrows them: a narrow view can still end
 * with none if the term matches more than this many contacts the caller
 * can see. Read in `CONTACT_ID_CHUNK` slices.
 */
export const INBOX_SEARCH_HIT_LIMIT = 300;

/** Chats listed that matched only through their last message. */
export const INBOX_SEARCH_TEXT_LIMIT = 50;

/** What a search found: the contacts, ranked, for the term asked. */
export interface InboxSearchHits {
  /** The cleaned term these hits answer. */
  term: string;
  /** Contact ids in rank order (exact first, then score). */
  ids: string[];
  /** Contact id -> its hit. */
  rank: ReadonlyMap<string, SearchHit>;
}

/** The hits for a term, in the order given (parseSearchHits ranks them). */
export function inboxSearchHits(
  term: string,
  hits: readonly SearchHit[]
): InboxSearchHits {
  const rank = new Map<string, SearchHit>();
  for (const h of hits) if (!rank.has(h.contactId)) rank.set(h.contactId, h);
  return { term, ids: [...rank.keys()], rank };
}

/** The term as both sides compare it: or-filter syntax stripped. */
export function inboxSearchTerm(term: string): string {
  return sanitizeContactSearch(term);
}

/**
 * A list row's contact, read from the embed: the list select carries
 * `contact:contacts(id, …)`, not the `contact_id` column.
 */
interface RowWithContact {
  contact?: { id?: string | null } | null;
}

function hitOf(
  row: RowWithContact,
  rank: ReadonlyMap<string, SearchHit>
): SearchHit | undefined {
  const id = row.contact?.id;
  return id ? rank.get(id) : undefined;
}

/**
 * Whether a chat is a close match: its contact was found, but not
 * exactly. A chat found only through its last message is not one.
 */
export function isCloseMatch(
  row: RowWithContact,
  rank: ReadonlyMap<string, SearchHit>
): boolean {
  const hit = hitOf(row, rank);
  return !!hit && !hit.exact;
}

/**
 * Search results in rank order: exact matches (a contact found exactly,
 * or a chat found through its last message) before close ones, a higher
 * score first within each, then the newest message first.
 */
export function sortByRank<
  T extends RowWithContact & { last_message_at?: string | null },
>(rows: readonly T[], rank: ReadonlyMap<string, SearchHit>): T[] {
  const keyed = rows.map((row) => {
    const hit = hitOf(row, rank);
    return {
      row,
      close: hit ? !hit.exact : false,
      score: hit ? hit.score : Number.NEGATIVE_INFINITY,
      at: row.last_message_at ? Date.parse(row.last_message_at) || 0 : 0,
    };
  });
  keyed.sort(
    (a, b) =>
      Number(a.close) - Number(b.close) ||
      (a.score === b.score ? 0 : b.score > a.score ? 1 : -1) ||
      b.at - a.at
  );
  return keyed.map((k) => k.row);
}

interface SearchableRow {
  last_message_text?: string | null;
  contact?: {
    id?: string | null;
    name?: string | null;
    phone?: string | null;
  } | null;
}

/** The same match on a held row: name, phone, phone digits or last message. */
export function matchesInboxSearch(row: SearchableRow, term: string): boolean {
  const clean = inboxSearchTerm(term);
  if (!clean) return true;
  const q = clean.toLowerCase();
  const name = row.contact?.name?.toLowerCase() ?? '';
  const phone = row.contact?.phone?.toLowerCase() ?? '';
  const lastMsg = row.last_message_text?.toLowerCase() ?? '';
  if (name.includes(q) || phone.includes(q) || lastMsg.includes(q)) {
    return true;
  }
  const digits = phoneSearchDigits(clean);
  return !!digits && phoneDigits(row.contact?.phone).includes(digits);
}

/**
 * The held-row match while a search is on: the text match, or the
 * chat's contact is one the search found (a close match shares no text
 * with the term and must not be dropped). The hits count only while
 * they answer the term in the box.
 */
export function matchesInboxSearchOrHit(
  row: SearchableRow,
  term: string,
  hits: InboxSearchHits | null
): boolean {
  if (matchesInboxSearch(row, term)) return true;
  return (
    !!hits && hits.term === inboxSearchTerm(term) && !!hitOf(row, hits.rank)
  );
}

/**
 * The two search reads as one list: chats of the found contacts first,
 * in hit rank order (as read among one contact's chats), then the chats
 * found only through their last message, as read (newest first). A chat
 * in both stays in the first place.
 */
export function mergeSearchRows<T extends RowWithContact & { id: string }>(
  contactRows: readonly T[],
  textRows: readonly T[],
  ids: readonly string[]
): T[] {
  const order = new Map(ids.map((id, i) => [id, i]));
  const at = (r: T) => order.get(r.contact?.id ?? '') ?? ids.length;
  const first = contactRows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => at(a.row) - at(b.row) || a.i - b.i)
    .map((x) => x.row);
  const seen = new Set(first.map((r) => r.id));
  const out = [...first];
  for (const r of textRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
