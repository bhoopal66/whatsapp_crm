import type { FeedItem } from '../feed';
import { itemEndMs, itemKey, itemStartMs } from './item-time';

const DAY_MS = 86_400_000;

/**
 * The rail's "Upcoming": items not yet over that start within the next
 * `days` days, soonest first.
 */
export function upcomingItems(
  items: readonly FeedItem[],
  nowMs: number,
  zone: string,
  days = 7,
  limit = 20
): FeedItem[] {
  const until = nowMs + days * DAY_MS;
  return items
    .map((item) => ({
      item,
      start: itemStartMs(item, zone),
      end: itemEndMs(item, zone),
      key: itemKey(item),
    }))
    .filter((x) => x.end > nowMs && x.start < until)
    .sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((x) => x.item);
}
