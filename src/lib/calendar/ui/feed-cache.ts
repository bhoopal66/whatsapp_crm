import type { FeedItem } from '../feed';

export const FEED_CACHE_TTL_MS = 30_000;

export function feedUrl(
  fromIso: string,
  toIso: string,
  includeWorkspaceMeetings: boolean
): string {
  const params = new URLSearchParams({ from: fromIso, to: toIso });
  if (includeWorkspaceMeetings) params.set('includeWorkspaceMeetings', '1');
  return `/api/calendar/feed?${params.toString()}`;
}

/** Feed responses per request URL (range + layers), for 30 s. */
export class FeedCache {
  private readonly entries = new Map<
    string,
    { at: number; items: FeedItem[] }
  >();

  constructor(
    private readonly ttlMs = FEED_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): FeedItem[] | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.items;
  }

  set(key: string, items: FeedItem[]): void {
    this.entries.set(key, { at: this.now(), items });
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Reads `{ items }` defensively; anything else is an empty feed. */
export function parseFeedResponse(body: unknown): FeedItem[] {
  if (!body || typeof body !== 'object') return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items) ? (items as FeedItem[]) : [];
}
