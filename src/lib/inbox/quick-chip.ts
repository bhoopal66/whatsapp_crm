/**
 * The Important and Pinned chips' filter. Tapped (`chip`), it ends with
 * its last chat; from a saved view or a link (`view`), it stays until
 * switched off, and shows the empty list when there are none.
 */
export type QuickChip = 'off' | 'chip' | 'view';

export const chipFromView = (on: boolean): QuickChip => (on ? 'view' : 'off');

export const tapChip = (chip: QuickChip): QuickChip =>
  chip === 'off' ? 'chip' : 'off';

/**
 * A chip can only be tapped on while it counts something, so a count of
 * 0 means its last chat is gone. Off for good: only hidden, the filter
 * came back by itself with the next such chat.
 */
export function chipForCount(
  chip: QuickChip,
  count: number,
  loading: boolean
): QuickChip {
  return chip === 'chip' && count === 0 && !loading ? 'off' : chip;
}

/** A filter that is on keeps its chip: the way to switch it off. */
export const chipShown = (chip: QuickChip, count: number): boolean =>
  count > 0 || chip !== 'off';
