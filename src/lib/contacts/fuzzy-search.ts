import { sanitizeContactSearch } from './search';

/**
 * Close-match contact search through migration 193's `search_contacts`
 * RPC (runs as the caller, so RLS decides which contacts come back),
 * ordered exact matches first, then by score. Pure helpers: the callers
 * (Contacts list, pickers, inboxes) do the I/O.
 *
 * Before 193 is applied the RPC is missing; callers then fall back to
 * the plain `ilike` filters, so nothing breaks.
 */

/** The RPC answers nothing for shorter terms; callers use ilike then. */
export const SEARCH_RPC_MIN_CHARS = 2;

export interface SearchHit {
  contactId: string;
  score: number;
  exact: boolean;
}

/** The term to send, or null when it is too short for the RPC. */
export function searchRpcTerm(term: string): string | null {
  const clean = sanitizeContactSearch(term);
  return clean.length >= SEARCH_RPC_MIN_CHARS ? clean : null;
}

/**
 * Whether an RPC error means "193 is not applied": PostgREST's
 * PGRST202 (function not in the schema cache) or Postgres's 42883
 * (undefined function). Any other error is a real failure.
 */
export function isMissingSearchRpc(
  error: { code?: string | null } | null | undefined
): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883';
}

/** RPC rows, well-formed only, in the order the RPC ranked them. */
export function parseSearchHits(data: unknown): SearchHit[] {
  if (!Array.isArray(data)) return [];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const { contact_id, score, exact } = r as Record<string, unknown>;
    if (typeof contact_id !== 'string' || seen.has(contact_id)) continue;
    seen.add(contact_id);
    out.push({
      contactId: contact_id,
      score: typeof score === 'number' ? score : 0,
      exact: exact === true,
    });
  }
  // Exact first, then score; the sort is stable, so ties keep the RPC's order.
  return out.sort(
    (a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score
  );
}

/**
 * Rows in the hits' rank order, each marked `closeMatch` when its hit
 * was not exact. Rows without a hit are dropped (the RPC is the search).
 */
export function rankByHits<T extends { id: string }>(
  rows: readonly T[],
  hits: readonly SearchHit[]
): (T & { closeMatch: boolean })[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: (T & { closeMatch: boolean })[] = [];
  for (const hit of hits) {
    const row = byId.get(hit.contactId);
    if (row) out.push({ ...row, closeMatch: !hit.exact });
  }
  return out;
}

/**
 * The conversations `or` group for a search: the chat's contact is one
 * the search found, or its last message holds the term. Goes through
 * `combineOrGroups` with the view's other groups, so every view filter
 * still applies. With no contact ids only the message branch is left.
 */
export function conversationSearchGroup(
  term: string,
  contactIds: readonly string[]
): string | null {
  const clean = sanitizeContactSearch(term);
  if (!clean) return null;
  const message = `last_message_text.ilike.%${clean}%`;
  return contactIds.length
    ? `contact_id.in.(${contactIds.join(',')}),${message}`
    : message;
}
