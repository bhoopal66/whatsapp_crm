/**
 * The Contacts bulk bar acts on the ticked rows, so a tick must never
 * outlive its row on screen: after any read of the list (a refresh
 * after a rename that drops the row out of the search included), keep
 * only the ids still shown.
 *
 * Returns `selected` itself when nothing was dropped, so a state
 * setter given the result bails out instead of re-rendering.
 */
export function pruneSelection(
  selected: Set<string>,
  visibleIds: Iterable<string>
): Set<string> {
  if (selected.size === 0) return selected;
  const visible = new Set(visibleIds);
  for (const id of selected) {
    if (!visible.has(id)) {
      return new Set([...selected].filter((s) => visible.has(s)));
    }
  }
  return selected;
}
