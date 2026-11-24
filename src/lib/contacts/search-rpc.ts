import { isUuid } from '@/lib/chat/mentions';
import {
  LEAD_SOURCE_COLUMN_AVAILABLE,
  parseLeadSources,
} from '@/lib/contacts/lead-source';

/**
 * The Contacts list's close-match search: `search_contacts` with the
 * screen's filters (migration 298), so the database narrows before it
 * limits. The filters used to be applied in the browser to the hits that
 * came back, and a customer past the limit was lost to all of them.
 *
 * All five names go out, null where a filter is off: PostgREST picks the
 * function by the names sent, and the two-argument one (193) is another.
 */

/** Hits the search returns at most (migration 298's own cap). */
export const CONTACT_SEARCH_MAX_HITS = 500;

export interface ContactSearchArgs {
  p_term: string;
  p_limit: number;
  p_owner: string | null;
  p_sources: string[] | null;
  p_chat_tags: string[] | null;
}

/** The arguments for one view; `term` is `searchRpcTerm`'s answer. */
export function contactSearchArgs(view: {
  term: string;
  /** A team leader's /contacts narrowing (contacts.user_id). */
  personalOnlyUserId: string | null;
  /** Main or sub tag ids, any of. */
  chatTagIds: readonly string[];
  /** Lead sources, any of; empty = all. */
  sources: readonly string[];
}): ContactSearchArgs {
  const tags = [...new Set(view.chatTagIds.filter(isUuid))].sort();
  const sources = LEAD_SOURCE_COLUMN_AVAILABLE
    ? parseLeadSources(view.sources)
    : [];
  return {
    p_term: view.term,
    p_limit: CONTACT_SEARCH_MAX_HITS,
    p_owner: view.personalOnlyUserId,
    p_sources: sources.length > 0 ? [...sources] : null,
    p_chat_tags: tags.length > 0 ? tags : null,
  };
}

/** The search filled its limit: there may be more than it listed. */
export function isSearchCapped(hitCount: number): boolean {
  return hitCount >= CONTACT_SEARCH_MAX_HITS;
}
