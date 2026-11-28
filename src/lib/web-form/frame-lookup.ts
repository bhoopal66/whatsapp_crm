/**
 * The middleware's lookup of a form's allowed origins for the frame
 * headers (frame-headers.ts). The loader is injected (the middleware
 * passes `loadPublicForm` on the service role), so this stays testable.
 *
 *  - Fails closed: a loader error or a timeout answers `[]` (no
 *    framing).
 *  - Never serves a stored answer. Every request reads the row, so an
 *    origin removed in Settings stops framing the form on the next
 *    request, on every server process: there is no window in which a
 *    removed site can still frame it. Only requests that arrive WHILE a
 *    read for the same token is in flight share that read, so a burst
 *    on one form costs one round trip, not one per request. The
 *    in-flight map is bounded, so random tokens cannot grow it.
 */

export interface FrameOriginsLookupOptions {
  /** Allowed origins of the form, or null when there is no such form. */
  load: (token: string) => Promise<{ allowedOrigins: string[] } | null>;
  /** Most tokens being read at once; further ones read unshared. */
  maxEntries?: number;
  timeoutMs?: number;
}

export function createFrameOriginsLookup(
  opts: FrameOriginsLookupOptions
): (token: string) => Promise<string[]> {
  const max = opts.maxEntries ?? 500;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const inFlight = new Map<string, Promise<string[]>>();

  const read = async (token: string): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const form = await Promise.race([
        opts.load(token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return form ? [...form.allowedOrigins] : [];
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return (token: string) => {
    const shared = inFlight.get(token);
    if (shared) return shared;
    const p = read(token);
    if (inFlight.size < max) {
      inFlight.set(token, p);
      void p.finally(() => {
        if (inFlight.get(token) === p) inFlight.delete(token);
      });
    }
    return p;
  };
}
