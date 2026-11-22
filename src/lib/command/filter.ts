import type { CommandEntry } from './entries';

/** Lower-case, accents folded, whitespace collapsed. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How well `query` matches a label and keywords: 0 for no match. Every
 * typed word must match somewhere; a label starting with the query beats
 * a word start, which beats a substring, which beats a keyword hit.
 */
export function scoreText(
  query: string,
  label: string,
  keywords: string = ''
): number {
  const q = normalize(query);
  if (!q) return 1;
  const l = normalize(label);
  const k = normalize(keywords);
  let score = l.startsWith(q) ? 100 : 0;
  for (const word of q.split(' ')) {
    let s = 0;
    if (l.startsWith(word)) s = 40;
    else if (l.split(' ').some((w) => w.startsWith(word))) s = 30;
    else if (l.includes(word)) s = 15;
    else if (k.includes(word)) s = 5;
    if (s === 0) return 0;
    score += s;
  }
  return score;
}

/**
 * The entries to list for `query`, best first (ties keep their order).
 * With no query, everything not marked `searchOnly`.
 */
export function rankEntries(
  entries: readonly CommandEntry[],
  query: string,
  textOf: (e: CommandEntry) => { label: string; keywords?: string }
): CommandEntry[] {
  if (!normalize(query)) return entries.filter((e) => !e.searchOnly);
  return entries
    .map((e, i) => {
      const { label, keywords } = textOf(e);
      return { e, i, s: scoreText(query, label, keywords) };
    })
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.e);
}

/** Next highlighted index for the list keys (arrows wrap). */
export function moveHighlight(
  current: number,
  count: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
): number {
  if (count <= 0) return 0;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}
