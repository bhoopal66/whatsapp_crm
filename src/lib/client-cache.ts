// ============================================================
// Tiny TTL cache for browser-side lookups that repeat on every
// screen.
//
// Why this exists
// ---------------
// Every Supabase query the browser makes is a full round trip to
// the public origin. On a tunnelled self-host that is expensive in
// a way it never is in development: measured against this
// deployment, the origin answers in ~20ms and the same request
// through Cloudflare and the tunnel takes ~700ms. Ten of those per
// screen is what "switching tabs is slow" actually is.
//
// Most of them are not even new questions. The tag list, the member
// list, a leader's team roster and the WhatsApp connection status
// are the same on every screen and change perhaps once a week, yet
// each mount asked again from scratch.
//
// What it does NOT do: conversations, messages, contacts — anything
// the user is actively reading or editing — must stay uncached. This
// is for slow-moving reference data only.
//
// The promise, not the value, is cached: two components mounting in
// the same tick share one in-flight request instead of racing two.
// A rejected load is evicted so the next caller retries rather than
// inheriting the failure for the rest of the TTL.
// ============================================================

interface Entry {
  /** In-flight or settled load. */
  promise: Promise<unknown>;
  /** Epoch ms after which this entry is no longer served. */
  expiresAt: number;
}

const store = new Map<string, Entry>();

/**
 * Run `loader` at most once per `ttlMs` for a given `key`.
 *
 * `key` must identify the *question*, not the caller — include any
 * parameter that changes the answer (`teams:leader:${userId}`), or
 * two users on one device will read each other's data.
 */
export function cachedQuery<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.promise as Promise<T>;

  const promise = loader();
  store.set(key, { promise, expiresAt: now + ttlMs });
  // Evict on failure so an offline blip isn't remembered as the
  // answer. Attach the guard to a derived promise: the caller's
  // rejection handling is unaffected, and no unhandled rejection is
  // reported for this internal branch.
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key);
  });
  return promise;
}

/**
 * Drop cached answers so the next read goes back to the database.
 *
 * Call after a write that changes one of them — creating a tag, for
 * instance — otherwise the screen that asks next keeps showing the
 * old list for the rest of the TTL. Passing a prefix invalidates
 * every key under it (`invalidateCached('teams:')`).
 */
export function invalidateCached(keyOrPrefix: string): void {
  if (store.delete(keyOrPrefix)) return;
  for (const key of store.keys()) {
    if (key.startsWith(keyOrPrefix)) store.delete(key);
  }
}

/** Drop everything. For tests, and for any future user switch that
 *  does not go through a full page load. */
export function clearClientCache(): void {
  store.clear();
}

// ------------------------------------------------------------
// Shared keys
//
// A key is a contract between whoever reads it and whoever
// invalidates it. Naming them here rather than typing the string at
// both ends is what keeps a rename from silently turning an
// invalidation into a no-op.
// ------------------------------------------------------------

/** Account members, for assignee pickers. */
export const MEMBERS_CACHE_KEY = 'members';

/** Prefix covering every leader's roster, for blanket invalidation. */
export const TEAM_ROSTER_CACHE_PREFIX = 'teams:leader:';

/** Roster of the team a given user leads. */
export function teamRosterCacheKey(userId: string): string {
  return `${TEAM_ROSTER_CACHE_PREFIX}${userId}`;
}

/** Prefix covering every account's chat tags, for blanket invalidation. */
export const CHAT_TAGS_CACHE_PREFIX = 'chat-tags:';

/**
 * The chat tags (migration 075) of a given account. Account-scoped
 * because the account changes the answer.
 */
export function chatTagsCacheKey(accountId: string): string {
  return `${CHAT_TAGS_CACHE_PREFIX}${accountId}`;
}

/**
 * How long reference data may be served without re-asking.
 *
 * Five minutes is the balance: long enough to cover a working
 * session's worth of tab switching, short enough that a change made
 * by a teammate (rather than by this tab, which invalidates
 * explicitly) shows up without a reload.
 */
export const REFERENCE_CACHE_TTL_MS = 5 * 60_000;

