import type { FeedItem } from '../feed';
import { itemKey, itemStartMs } from './item-time';

export function normaliseQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** Title or location contains the query, case-insensitively. */
export function itemMatches(item: FeedItem, query: string): boolean {
  const q = normaliseQuery(query);
  if (!q) return false;
  if (item.title.toLocaleLowerCase().includes(q)) return true;
  return (
    item.kind === 'event' &&
    !!item.location &&
    item.location.toLocaleLowerCase().includes(q)
  );
}

/** Matching items in start order (ties by key, so the order is stable). */
export function searchMatches(
  items: readonly FeedItem[],
  query: string,
  zone: string
): FeedItem[] {
  return items
    .filter((item) => itemMatches(item, query))
    .map((item) => ({ item, at: itemStartMs(item, zone), key: itemKey(item) }))
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
    .map((x) => x.item);
}

/**
 * Where Enter goes: the match after the current one (wrapping round),
 * or with none current, the first match starting at or after `fromMs`
 * (else the first of all).
 */
export function nextMatch(
  matches: readonly FeedItem[],
  currentKey: string | null,
  fromMs: number,
  zone: string
): FeedItem | null {
  if (matches.length === 0) return null;
  if (currentKey) {
    const i = matches.findIndex((m) => itemKey(m) === currentKey);
    if (i >= 0) return matches[(i + 1) % matches.length];
  }
  return matches.find((m) => itemStartMs(m, zone) >= fromMs) ?? matches[0];
}
