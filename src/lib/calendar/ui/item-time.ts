import type { FeedItem } from '../feed';
import { wallArrayToTimestamp } from '../fc-timezone';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A feed date ('YYYY-MM-DD' for all-day, else ISO) as an instant. */
export function feedDateMs(value: string, zone: string): number {
  const m = DATE_ONLY.exec(value);
  if (!m) return Date.parse(value);
  return wallArrayToTimestamp(zone, [
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    0,
    0,
    0,
    0,
  ]);
}

export function itemStartMs(item: FeedItem, zone: string): number {
  return feedDateMs(item.start, zone);
}

export function itemEndMs(item: FeedItem, zone: string): number {
  const end = feedDateMs(item.end, zone);
  return Number.isFinite(end) ? end : itemStartMs(item, zone);
}

/** Distinguishes occurrences of one recurring event. */
export function itemKey(item: FeedItem): string {
  return `${item.kind}:${item.id}:${item.occurrenceStart}`;
}
