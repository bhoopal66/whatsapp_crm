/**
 * Where a contact came from (`contacts.lead_source`, a nullable text
 * column added by migration 249; `lead_source_detail` is jsonb). Kept
 * dependency-free so client and server share it and tests need nothing.
 */

import { LEAD_SOURCES, type LeadSource } from '@/lib/leads/lead-source';

// One list for the whole app: 249's CHECK is pinned to it in leads/.
export { LEAD_SOURCES, type LeadSource };

/**
 * False until migration 249 (contacts.lead_source) is applied: with it
 * off the Source column and filter are hidden and the query never names
 * the column, so the list works on a database without it. 249 is merged
 * before release, so this ships as true.
 */
export const LEAD_SOURCE_COLUMN_AVAILABLE = true;

export function isLeadSource(value: unknown): value is LeadSource {
  return (
    typeof value === 'string' &&
    (LEAD_SOURCES as readonly string[]).includes(value)
  );
}

/** Known sources of a comma list or array, deduped, in canonical order. */
export function parseLeadSources(
  raw: string | readonly unknown[] | null | undefined
): LeadSource[] {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const wanted = new Set(
    parts.map((p) => (typeof p === 'string' ? p.trim() : p))
  );
  return LEAD_SOURCES.filter((s) => wanted.has(s));
}

/** A row's source, or null for none / a value this build does not know. */
export function leadSourceOf(row: object): LeadSource | null {
  const value = (row as { lead_source?: unknown }).lead_source;
  return isLeadSource(value) ? value : null;
}

/**
 * The filter for "any of these sources" as a PostgREST or-group
 * (`lead_source.in.(ad,web_form)`), or null for no narrowing. Only known
 * values reach the string, so it cannot carry filter syntax.
 */
export function leadSourceFilter(
  sources: readonly string[] | null | undefined
): string | null {
  const known = parseLeadSources(sources ?? []);
  return known.length > 0 ? `lead_source.in.(${known.join(',')})` : null;
}
