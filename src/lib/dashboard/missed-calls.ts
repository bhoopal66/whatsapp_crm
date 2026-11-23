/**
 * The home's "Missed calls" figure. `listed` is the missed calls in this
 * person's loaded task list (undefined while it is not loaded, or could
 * not be), `full` that the list was cut at its cap, and `badge` the exact
 * head count (null when unknown). Null means not known, which the tile
 * must never show as "All clear".
 */
export function missedCallCount(
  listed: number | undefined,
  full: boolean,
  badge: number | null
): number | null {
  if (listed === undefined) return badge;
  // A list that was cut short is a floor, so none in it proves nothing.
  if (full) return badge === null ? listed || null : Math.max(listed, badge);
  return listed;
}
