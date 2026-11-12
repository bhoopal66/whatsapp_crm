/**
 * Ported from wacrm module 022a (second brain): splits text into chunks of
 * at most `max` (default 800) chars on sentence boundaries. Sentences are
 * packed greedily; a single sentence longer than `max` is split at the last
 * whitespace before the limit (or hard at the limit when it has none).
 * Whitespace is collapsed; empty input gives no chunks.
 */
export const CHUNK_MAX = 800;

const SENTENCE = /[^.!?\n]+(?:[.!?]+|\n+|$)/g;

function splitLong(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(' ', max);
    const at = cut > 0 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function chunkText(text: string, max: number = CHUNK_MAX): string[] {
  const sentences = (text.match(SENTENCE) ?? [])
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    for (const piece of s.length > max ? splitLong(s, max) : [s]) {
      if (cur && cur.length + 1 + piece.length <= max) cur = `${cur} ${piece}`;
      else {
        if (cur) out.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}
