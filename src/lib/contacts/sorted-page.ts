import {
  LEAD_SOURCE_COLUMN_AVAILABLE,
  parseLeadSources,
} from '@/lib/contacts/lead-source';
import { contactSearchTerms } from '@/lib/contacts/list-query';
import type { ContactSort, ServerSortKey } from '@/lib/contacts/sort';

/**
 * The Contacts list sorted by owner, assigned person or last activity:
 * migration 257's `contacts_sorted_page` RPC orders the whole filtered
 * match set and returns one page of ids plus the total. SECURITY
 * INVOKER, so contacts RLS decides exactly as the plain list's query.
 * Pure: the arguments and the reply's parsing are tested here; the page
 * makes the call.
 */

export const SORTED_PAGE_RPC = 'contacts_sorted_page';

/** UUIDs only: anything else in the chat-tag filter is dropped. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SortedPageView {
  sort: ContactSort & { sort: ServerSortKey };
  /** A team leader's /contacts narrowing (contacts.user_id). */
  personalOnlyUserId: string | null;
  /** The search term as queried (the plain, non-ranked search). */
  search: string;
  /** Chat-tag filter: main or sub tag ids, any of. */
  chatTagIds: readonly string[];
  /** Lead sources, any of; empty = all. */
  sources?: readonly string[];
  page: number;
}

export interface SortedPageArgs {
  p_sort: ServerSortKey;
  p_dir: 'asc' | 'desc';
  p_limit: number;
  p_offset: number;
  p_owner_id: string | null;
  p_search_like: string | null;
  p_search_digits: string | null;
  p_chat_tag_ids: string[] | null;
  p_sources: string[] | null;
}

/**
 * The RPC's arguments for one page of a view: the same search pattern
 * and digits as the plain query (`contactSearchTerms`), the chat-tag
 * ids `chatTagFilterOrGroup` would send, the known lead sources and the
 * owner narrowing.
 */
export function sortedPageRpcArgs(
  view: SortedPageView,
  pageSize: number
): SortedPageArgs {
  const terms = contactSearchTerms(view.search.trim());
  const tags = [
    ...new Set(view.chatTagIds.filter((id) => UUID_RE.test(id))),
  ].sort();
  const sources = LEAD_SOURCE_COLUMN_AVAILABLE
    ? parseLeadSources(view.sources ?? [])
    : [];
  const size = Math.max(1, Math.floor(pageSize));
  return {
    p_sort: view.sort.sort,
    p_dir: view.sort.dir,
    p_limit: size,
    p_offset: Math.max(0, Math.floor(view.page)) * size,
    p_owner_id: view.personalOnlyUserId,
    p_search_like: terms?.like ?? null,
    p_search_digits: terms?.digits ?? null,
    p_chat_tag_ids: tags.length > 0 ? tags : null,
    p_sources: sources.length > 0 ? [...sources] : null,
  };
}

/**
 * The RPC's reply `{ ids, total }`, or null when it is not that shape
 * (the caller treats null as a failed read). Ids keep their order;
 * non-string and repeated ids are dropped.
 */
export function parseSortedPage(
  data: unknown
): { ids: string[]; total: number } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { ids, total } = data as Record<string, unknown>;
  if (!Array.isArray(ids)) return null;
  const n = typeof total === 'string' ? Number(total) : total;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return { ids: out, total: Math.floor(n) };
}

/**
 * Whether an RPC error means "257 is not applied": PostgREST's PGRST202
 * (function not in the schema cache) or Postgres's 42883 (undefined
 * function). Any other error is a real failure.
 */
export function isMissingSortRpc(
  error: { code?: string | null } | null | undefined
): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883';
}
