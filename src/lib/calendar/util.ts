// ============================================================
// Calendar — small shared helpers.
// ============================================================

/**
 * `arr` cut into consecutive slices of at most `size` items, so a long
 * PostgREST `.in()` list stays well under URL length limits.
 */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (!(size >= 1)) throw new RangeError('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
