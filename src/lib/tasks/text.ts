/**
 * Length and truncation in characters (code points), the unit of the
 * table's `char_length` CHECKs. A JS string's `.length` counts UTF-16
 * units, so it over-counts an emoji, and slicing by it can cut one in
 * half, leaving a lone surrogate the database refuses.
 */

export function charLength(text: string): number {
  return Array.from(text).length;
}

/** `text` cut to at most `max` characters, never inside a character. */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}
