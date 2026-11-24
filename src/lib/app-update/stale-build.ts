/**
 * A tab opened before a release asks for lazy chunks the release deleted.
 * React's lazy remembers the rejection, so no retry inside the page can
 * work: only a reload brings the new build.
 */

export const RELOAD_STAMP_KEY = 'wacrm-stale-build-reload';
/** At most one reload by itself in this time, per tab: never a loop. */
export const RELOAD_GAP_MS = 5 * 60_000;

/** How each engine and bundler says a part of the app did not load. */
const MESSAGES = [
  // Turbopack (this build), webpack, its CSS.
  /Failed to load chunk /i,
  /Loading (?:CSS )?chunk \S+ failed/i,
  // import() itself: Chrome, Firefox, Safari.
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
];

/** Whether a part of the app's code could not be loaded. */
export function isChunkLoadError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string' && MESSAGES.some((re) => re.test(message));
}

/**
 * Takes this tab's one reload of the window, if it is free. Without
 * storage nothing could stop a loop, so there is none to take.
 */
export function takeReload(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now: number
): boolean {
  try {
    if (!storage) return false;
    const stamp = storage.getItem(RELOAD_STAMP_KEY);
    const at = stamp === null ? Number.NaN : Number(stamp);
    // A stamp from the future (the clock was set back) counts as old.
    if (now >= at && now - at < RELOAD_GAP_MS) return false;
    storage.setItem(RELOAD_STAMP_KEY, String(now));
    // Some private modes accept a write and keep nothing.
    return storage.getItem(RELOAD_STAMP_KEY) === String(now);
  } catch {
    return false;
  }
}
