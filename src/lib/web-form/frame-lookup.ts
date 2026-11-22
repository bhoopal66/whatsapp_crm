/**
 * The middleware's lookup of a form's allowed origins for the frame
 * headers (frame-headers.ts). The loader is injected (the middleware
 * passes `loadPublicForm` on the service role), so this stays testable.
 *
 *  - Fails closed: a loader error or a timeout answers `[]` (no
 *    framing) and is not cached, so the next request asks again.
 *  - Caches answers, found or not, for `ttlMs` per process. The hosted
 *    page reads the same row anyway; the cache only spares a second
 *    round trip per view. An edit in Settings reaches framing within
 *    `ttlMs`. The map is bounded, so random tokens cannot grow it.
 */

export interface FrameOriginsLookupOptions {
  /** Allowed origins of the form, or null when there is no such form. */
  load: (token: string) => Promise<{ allowedOrigins: string[] } | null>;
  ttlMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
  now?: () => number;
}

export const FRAME_LOOKUP_TTL_MS = 30_000;

export function createFrameOriginsLookup(
  opts: FrameOriginsLookupOptions
): (token: string) => Promise<string[]> {
  const ttl = opts.ttlMs ?? FRAME_LOOKUP_TTL_MS;
  const max = opts.maxEntries ?? 500;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; origins: string[] }>();

  return async (token: string) => {
    const hit = cache.get(token);
    if (hit && now() - hit.at < ttl) return hit.origins;
    if (hit) cache.delete(token);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const form = await Promise.race([
        opts.load(token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      const origins = form ? [...form.allowedOrigins] : [];
      if (cache.size >= max) {
        // Oldest first: a Map iterates in insertion order.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(token, { at: now(), origins });
      return origins;
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
