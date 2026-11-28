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

/**
 * The filter's "Unknown": no lead source recorded (`lead_source IS
 * NULL`; 249's CHECK never stores ''). A filter value only, never a
 * stored one; migration 331 teaches the two RPCs that read the filter.
 */
export const UNKNOWN_LEAD_SOURCE = 'unknown';

/** What the lead-source filter can hold: a named source, or Unknown. */
export type LeadSourceFilterValue = LeadSource | typeof UNKNOWN_LEAD_SOURCE;

/** The filter's options in display order: the sources, then Unknown. */
export const LEAD_SOURCE_FILTER_VALUES: readonly LeadSourceFilterValue[] = [
  ...LEAD_SOURCES,
  UNKNOWN_LEAD_SOURCE,
];

/**
 * Filter values of a comma list or array (`?source=ad,unknown`), deduped,
 * in canonical order (Unknown last); anything else is dropped.
 */
export function parseLeadSources(
  raw: string | readonly unknown[] | null | undefined
): LeadSourceFilterValue[] {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const wanted = new Set(
    parts.map((p) => (typeof p === 'string' ? p.trim() : p))
  );
  return LEAD_SOURCE_FILTER_VALUES.filter((s) => wanted.has(s));
}

/** A row's source, or null for none / a value this build does not know. */
export function leadSourceOf(row: object): LeadSource | null {
  const value = (row as { lead_source?: unknown }).lead_source;
  return isLeadSource(value) ? value : null;
}

/**
 * The filter for "any of these sources" as a PostgREST or-group
 * (`lead_source.in.(ad,web_form)`, plus `lead_source.is.null` for
 * Unknown), or null for no narrowing. Only known values reach the
 * string, so it cannot carry filter syntax. Sent as its own `or=` group,
 * which PostgREST ANDs with the search's.
 */
export function leadSourceFilter(
  sources: readonly string[] | null | undefined
): string | null {
  const values = parseLeadSources(sources ?? []);
  const named = values.filter((v) => v !== UNKNOWN_LEAD_SOURCE);
  const parts: string[] = [];
  if (named.length > 0) parts.push(`lead_source.in.(${named.join(',')})`);
  if (values.includes(UNKNOWN_LEAD_SOURCE)) parts.push('lead_source.is.null');
  return parts.length > 0 ? parts.join(',') : null;
}
