/**
 * The Inbox search box, on the server and on the rows held.
 *
 * A search used to filter only the rows already loaded, so an older chat
 * beyond the first pages could not be found at all. Now the typed term is
 * pushed into the list query like any other filter (every view narrowing
 * still applies), and the same match is re-applied to the held rows,
 * which realtime and deltas keep changing.
 *
 * The server match is one query: the contact is embedded a second time,
 * empty and under its own alias, filtered on name / phone / phone digits,
 * and the conversation is kept when that embed is non-null OR its last
 * message matches (PostgREST's "OR filtering across embedded resources").
 */

import { phoneDigits, phoneSearchDigits } from '@/lib/contacts/phone-search';
import { sanitizeContactSearch } from '@/lib/contacts/search';

/** Pause after typing before asking the server. */
export const INBOX_SEARCH_DEBOUNCE_MS = 300;

/** The alias of the empty, filter-only contacts embed. */
export const INBOX_SEARCH_CONTACT_ALIAS = 'search_contact';

/** Added to the list's select while searching. */
export const INBOX_SEARCH_EMBED = `${INBOX_SEARCH_CONTACT_ALIAS}:contacts()`;

export interface InboxSearchQuery {
  /** `.or(contactOr, { referencedTable: INBOX_SEARCH_CONTACT_ALIAS })`. */
  contactOr: string;
  /** One `or` group for the conversations themselves (combineOrGroups). */
  group: string;
}

/** The term as both sides compare it: or-filter syntax stripped. */
export function inboxSearchTerm(term: string): string {
  return sanitizeContactSearch(term);
}

/** The server-side filters for a typed term, or null for no search. */
export function inboxSearchQuery(term: string): InboxSearchQuery | null {
  const clean = inboxSearchTerm(term);
  if (!clean) return null;
  const like = `%${clean}%`;
  const parts = [`name.ilike.${like}`, `phone.ilike.${like}`];
  const digits = phoneSearchDigits(clean);
  if (digits) parts.push(`phone_normalized.like.%${digits}%`);
  return {
    contactOr: parts.join(','),
    group: `${INBOX_SEARCH_CONTACT_ALIAS}.not.is.null,last_message_text.ilike.${like}`,
  };
}

interface SearchableRow {
  last_message_text?: string | null;
  contact?: { name?: string | null; phone?: string | null } | null;
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
