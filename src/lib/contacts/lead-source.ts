/**
 * Where a contact came from (`contacts.lead_source`, migration 249).
 * Dependency-free so client components and tests can import it.
 */
export const LEAD_SOURCES = [
  'ad',
  'web_form',
  'broadcast',
  'manual',
  'import',
  'compass',
  'other',
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];
