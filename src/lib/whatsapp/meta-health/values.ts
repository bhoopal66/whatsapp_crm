/**
 * The value sets of migration 188's CHECKs and their normalisers. Pure and
 * dependency-free, so client code may import it (ingest.ts may not).
 */
export const QUALITY_RATINGS = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
export type QualityRating = (typeof QUALITY_RATINGS)[number];

export const ASSESSED_STATES = [
  'NORMAL',
  'THROTTLED',
  'MARKETING_PAUSED',
  'ALL_PAUSED',
] as const;
export type AssessedState = (typeof ASSESSED_STATES)[number];

/** GREEN | YELLOW | RED | UNKNOWN (case and spaces forgiven), else null. */
export function normalizeQuality(v: unknown): QualityRating | null {
  if (typeof v !== 'string') return null;
  const q = v.trim().toUpperCase();
  return (QUALITY_RATINGS as readonly string[]).includes(q)
    ? (q as QualityRating)
    : null;
}

/**
 * Trimmed text of 1..max characters, else null (188's `!~ '^[[:space:]]*$'`
 * and `char_length <= max` CHECKs). U+0085 and U+180E are not JS whitespace
 * but may be [[:space:]] to Postgres, so all-of-those is blank too. JS length
 * counts UTF-16 units, never fewer than char_length's code points.
 */
export function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return !/^[\s\u0085\u180e]*$/.test(t) && t.length <= max ? t : null;
}
