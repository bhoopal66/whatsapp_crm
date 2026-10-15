import type { FeedItem } from '../feed';

/**
 * How one event chip is laid out, by view and length:
 * - `full`: time grid, long enough for title, time and details on
 *   separate lines;
 * - `compact`: time grid, too short for that, so title and time share
 *   one line;
 * - `row`: a timed item in a month or year cell, time then title;
 * - `bar`: an all-day item (any view), title only;
 * - `list`: the agenda, whose own column already shows the time.
 */
export type ChipLayout = 'full' | 'compact' | 'row' | 'bar' | 'list';

/** Below this many minutes a time-grid chip has room for one line only. */
export const COMPACT_BELOW_MIN = 30;

export function chipLayout(
  viewType: string,
  allDay: boolean,
  startMs: number | null,
  endMs: number | null
): ChipLayout {
  if (viewType.startsWith('list')) return 'list';
  if (allDay) return 'bar';
  if (!viewType.startsWith('timeGrid')) return 'row';
  if (startMs === null || endMs === null) return 'compact';
  return endMs - startMs < COMPACT_BELOW_MIN * 60_000 ? 'compact' : 'full';
}

/** The details a chip can show beyond its title and time. */
export interface ChipDetails {
  location: string | null;
  /** People invited besides the organiser; 0 when none or not an event. */
  attendees: number;
  recurring: boolean;
}

export function chipDetails(item: FeedItem): ChipDetails {
  if (item.kind !== 'event') {
    return { location: null, attendees: 0, recurring: false };
  }
  const location = item.location?.trim() || null;
  return {
    location,
    attendees: Math.max(0, item.attendeeCount),
    recurring: item.recurring,
  };
}
