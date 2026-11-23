/**
 * Where a thread's list is scrolled to after its content changed:
 * someone at the bottom follows the new replies, anyone else keeps the
 * reply they are reading where it was, whatever came, went or changed
 * height above it.
 */

/** Within this of the end counts as the bottom (as the main timeline). */
export const AT_BOTTOM_PX = 80;

/** A row's edges, measured from the top of the list's viewport. */
export interface RowBox {
  id: string;
  top: number;
  bottom: number;
}

export interface ThreadScroll {
  atBottom: boolean;
  /** The rows in view, the one to hold in place first. */
  rows: { id: string; top: number }[];
}

/**
 * What to hold, taken before a change. The replies come before the root:
 * older replies go in right under the root, and holding the root would
 * push what is being read away. Null with no rows (the loading line), so
 * a thread opens at its root.
 */
export function holdThread(
  rows: readonly RowBox[],
  rootId: string,
  el: { scrollTop: number; scrollHeight: number; clientHeight: number }
): ThreadScroll | null {
  if (rows.length === 0) return null;
  const seen = rows
    .filter((r) => r.bottom > 0 && r.top < el.clientHeight)
    .map(({ id, top }) => ({ id, top }));
  return {
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX,
    rows: [
      ...seen.filter((r) => r.id !== rootId),
      ...seen.filter((r) => r.id === rootId),
    ],
  };
}

/**
 * How far to scroll after the change. Nothing when the browser's own
 * scroll anchoring already held the row.
 */
export function threadScrollBy(
  held: ThreadScroll,
  topOf: (id: string) => number | null,
  el: { scrollTop: number; scrollHeight: number }
): number {
  if (held.atBottom) return el.scrollHeight - el.scrollTop;
  for (const row of held.rows) {
    const top = topOf(row.id);
    if (top !== null) return top - row.top;
  }
  return 0;
}
