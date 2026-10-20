/**
 * Browser-side contact search (the pipelines ContactPicker, the Cases page's
 * "New lead" customer picker): pure query building and result parsing. The
 * query runs on the caller's own Supabase client, so RLS decides which
 * contacts they can find.
 */

export interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

/** Pause after typing before asking the server. */
export const CONTACT_SEARCH_DEBOUNCE_MS = 300;
/** Matches shown per search. */
export const CONTACT_SEARCH_LIMIT = 20;

/**
 * Strip the characters that are syntax inside a PostgREST `or=(…)`
 * filter, so a search like "Acme, Inc (UK)" narrows instead of
 * producing a malformed request.
 */
export function sanitizeContactSearch(term: string): string {
  return term.replace(/[,()"\\]/g, ' ').trim();
}

/** The `.or()` filter for a typed term, or null when it is empty. */
export function contactSearchFilter(term: string): string | null {
  const clean = sanitizeContactSearch(term);
  if (!clean) return null;
  const like = `%${clean}%`;
  return `name.ilike.${like},phone.ilike.${like}`;
}

/** Rows from the contacts query, keeping only well-formed ones. */
export function parseContactOptions(data: unknown): ContactOption[] {
  if (!Array.isArray(data)) return [];
  const out: ContactOption[] = [];
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const { id, name, phone } = r as Record<string, unknown>;
    if (typeof id !== 'string' || typeof phone !== 'string') continue;
    out.push({ id, name: typeof name === 'string' ? name : null, phone });
  }
  return out;
}
