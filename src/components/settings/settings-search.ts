import type { SettingsSection } from './settings-sections';

/** One searchable menu entry, already translated. */
export interface SettingsSearchItem {
  section: SettingsSection;
  /** The entry's label: a match here ranks first. */
  label: string;
  /** Searched but not ranked: the group's label, the section's hint and
   *  its extra keywords. */
  terms: string;
}

/**
 * Fold case and accents, and collapse whitespace. Hangul decomposes to
 * its letters under NFKD, so a half-typed syllable (프로ㅍ while typing
 * 프로필) still matches.
 */
export function normaliseSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The sections whose label or terms contain every word of `query`,
 * best first: a label that starts with the query, then a label that
 * contains it, then the rest. Ties keep their order in `items` (the
 * menu's order). An empty query matches nothing: the menu shows its
 * groups instead.
 */
export function searchSettings(
  query: string,
  items: readonly SettingsSearchItem[]
): SettingsSection[] {
  const q = normaliseSearch(query);
  if (!q) return [];
  const words = q.split(' ');
  const hits: { section: SettingsSection; rank: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = normaliseSearch(item.label);
    const haystack = `${label} ${normaliseSearch(item.terms)}`;
    if (!words.every((w) => haystack.includes(w))) return;
    const rank = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
    hits.push({ section: item.section, rank, index });
  });
  return hits
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((h) => h.section);
}
