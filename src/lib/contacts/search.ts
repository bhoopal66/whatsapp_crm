import { latinDigits } from './digits';
import { phoneSearchDigits } from './phone-search';

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
  // `*` is PostgREST's own wildcard (it reads it as `%`), so it is dropped.
  // Arabic-keyboard digits become 0-9: phones are stored in 0-9.
  const clean = latinDigits(term)
    .replace(/[,()"\\]/g, ' ')
    .replace(/\*/g, '')
    .trim();
  // Only punctuation or wildcards ("%%%", "_", "+") searches for nothing.
  return /[\p{L}\p{N}]/u.test(clean) ? clean : '';
}

/**
 * A cleaned term as the literal text of an `ilike` pattern: `%` and `_`
 * would otherwise be wildcards (`%%%%` matched every chat). Postgres's
 * default escape character is the backslash, which the sanitiser has
 * already stripped from the term itself.
 */
export function escapeIlike(clean: string): string {
  return clean.replace(/[%_]/g, '\\$&');
}

/**
 * The `.or()` filter for a typed term, or null when it is empty. A term
 * of digits also matches the phone's digits alone (`phone_normalized`),
 * so `588336503` finds `+971 58 833 6503`.
 */
export function contactSearchFilter(term: string): string | null {
  const clean = sanitizeContactSearch(term);
  if (!clean) return null;
  const like = `%${escapeIlike(clean)}%`;
  const parts = [`name.ilike.${like}`, `phone.ilike.${like}`];
  const digits = phoneSearchDigits(clean);
  if (digits) parts.push(`phone_normalized.like.%${digits}%`);
  return parts.join(',');
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
