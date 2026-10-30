// ============================================================
// Per-tab, in-memory, stale-while-revalidate cache for screen data:
// chat lists, messages, contacts — what the user is actually reading.
//
// Why this exists
// ---------------
// A browser round trip costs ~0.4–0.7 s through the tunnel, so a
// screen that refetches from scratch on every visit makes the user
// wait for data they saw a moment ago. This keeps the last answer to
// each question and shows it at once while a fresh copy loads.
//
// The rule (approved by the product owner)
// ----------------------------------------
// - Memory only. Nothing here is ever written to localStorage,
//   sessionStorage, IndexedDB or a cookie; a reload starts empty.
// - Kept separately per user and workspace: every key is built by
//   `sessionKey(accountId, userId, question)`, which refuses to build
//   one without both.
// - Wiped on sign-out, workspace switch, or a different user signing
//   in to this tab (`hooks/use-auth.tsx` calls `sessionCache.clear()`
//   and `noteSessionUser()`).
// - Always refreshed the moment it is shown: there is no TTL and no
//   entry is ever "fresh". A cached value is only a starting point;
//   `useSessionQuery` revalidates on every mount and key change.
//
// Reference data that changes once a week (tags, members, rosters)
// stays in `client-cache.ts`, which may skip the round trip entirely.
// ============================================================

/** Most entries kept; the least recently used goes first. */
export const SESSION_CACHE_MAX_ENTRIES = 300;

declare const sessionKeyBrand: unique symbol;

/** A key built by `sessionKey`, so it always names account and user. */
export type SessionKey = string & { readonly [sessionKeyBrand]: true };

export interface SessionEntry<T = unknown> {
  value: T;
  /** Epoch ms the value was stored. Informational: nothing expires. */
  storedAt: number;
}

type Listener = () => void;

/**
 * The cache key for `question` as asked by `userId` in `accountId`.
 * Null while either is unknown, so a caller can pass the result
 * straight to `useSessionQuery` (null = do not query yet).
 *
 * `question` names everything else that changes the answer
 * (`inbox:list:team`, `messages:<conversationId>`). A prefix of a key
 * built the same way (`sessionKey(a, u, 'messages:')`) is what
 * `deletePrefix` takes.
 */
export function sessionKey(
  accountId: string | null | undefined,
  userId: string | null | undefined,
  question: string
): SessionKey | null {
  if (!accountId || !userId) return null;
  return `s:${accountId}:${userId}:${question}` as SessionKey;
}

interface Inflight {
  promise: Promise<unknown>;
  /** Fetch sequence number for this key; only the latest may write. */
  seq: number;
}

export interface SessionCache {
  get<T>(key: SessionKey): SessionEntry<T> | undefined;
  /** Like `get` without marking the entry as recently used. */
  peek<T>(key: SessionKey): SessionEntry<T> | undefined;
  set<T>(key: SessionKey, value: T, now?: number): void;
  /**
   * Patch a cached value (realtime handlers). A key with nothing
   * cached is left alone — the next fetch brings the whole answer.
   * Returns whether anything was patched.
   */
  update<T>(key: SessionKey, fn: (prev: T) => T, now?: number): boolean;
  delete(key: SessionKey): void;
  deletePrefix(prefix: SessionKey): void;
  clear(): void;
  /** Called on every change to `key`'s value or its fetching state. */
  subscribe(key: SessionKey, listener: Listener): () => void;
  isFetching(key: SessionKey): boolean;
  size(): number;
}

const entries = new Map<SessionKey, SessionEntry>();
const listeners = new Map<SessionKey, Set<Listener>>();
const inflight = new Map<SessionKey, Inflight>();
let fetchSeq = 0;

function notify(key: SessionKey): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of [...set]) listener();
}

function evict(): void {
  if (entries.size <= SESSION_CACHE_MAX_ENTRIES) return;
  // Map order is insertion order, and a touch re-inserts, so the first
  // keys are the least recently used. A key a mounted screen is showing
  // is skipped: evicting it would blank that screen.
  for (const key of entries.keys()) {
    if (entries.size <= SESSION_CACHE_MAX_ENTRIES) return;
    if (listeners.get(key)?.size) continue;
    entries.delete(key);
  }
}

function touch(key: SessionKey, entry: SessionEntry): void {
  entries.delete(key);
  entries.set(key, entry);
}

export const sessionCache: SessionCache = {
  get<T>(key: SessionKey) {
    const entry = entries.get(key);
    if (entry) touch(key, entry);
    return entry as SessionEntry<T> | undefined;
  },

  peek<T>(key: SessionKey) {
    return entries.get(key) as SessionEntry<T> | undefined;
  },

  set<T>(key: SessionKey, value: T, now: number = Date.now()) {
    touch(key, { value, storedAt: now });
    evict();
    notify(key);
  },

  update<T>(key: SessionKey, fn: (prev: T) => T, now: number = Date.now()) {
    const entry = entries.get(key) as SessionEntry<T> | undefined;
    if (!entry) return false;
    touch(key, { value: fn(entry.value), storedAt: now });
    notify(key);
    return true;
  },

  delete(key: SessionKey) {
    if (entries.delete(key)) notify(key);
  },

  deletePrefix(prefix: SessionKey) {
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) {
        entries.delete(key);
        notify(key);
      }
    }
  },

  clear() {
    // Dropping the in-flight records is what stops a fetch started
    // before a sign-out or switch from writing its answer back.
    const keys = new Set([...entries.keys(), ...inflight.keys()]);
    entries.clear();
    inflight.clear();
    for (const key of keys) notify(key);
  },

  subscribe(key: SessionKey, listener: Listener) {
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(key);
    };
  },

  isFetching(key: SessionKey) {
    return inflight.has(key);
  },

  size() {
    return entries.size;
  },
};

/**
 * Whether a finished fetch may write its answer: only while it is still
 * the key's in-flight fetch. An older one would overwrite a newer
 * answer, and one that `clear()` dropped (sign-out, switch) would put
 * the previous user's data back.
 */
export function shouldStoreFetchResult(fetch: {
  seq: number;
  latestSeq: number | undefined;
}): boolean {
  return fetch.seq === fetch.latestSeq;
}

/**
 * Fetch `key` and store the answer. Joins a fetch already in flight for
 * the key (two prefetches, or a hover prefetch followed by the screen,
 * make one request); `force` starts a new one, whose answer then wins
 * over the older one's. Rejects with the fetcher's error; the cached
 * value, if any, is kept.
 */
export function prefetchSession<T>(
  key: SessionKey,
  fetcher: () => Promise<T>,
  opts: { force?: boolean } = {}
): Promise<T> {
  const running = inflight.get(key);
  if (running && !opts.force) return running.promise as Promise<T>;

  const seq = ++fetchSeq;
  const promise = (async () => {
    try {
      const value = await fetcher();
      if (shouldStoreFetchResult({ seq, latestSeq: inflight.get(key)?.seq })) {
        sessionCache.set(key, value);
      }
      return value;
    } finally {
      if (inflight.get(key)?.seq === seq) {
        inflight.delete(key);
        notify(key);
      }
    }
  })();
  inflight.set(key, { promise, seq });
  notify(key);
  return promise;
}

// ------------------------------------------------------------
// User change without a reload
// ------------------------------------------------------------

let boundUserId: string | null = null;

/**
 * Tell the cache who is signed in to this tab. A change of user —
 * including to nobody — empties it. Keys carry the user id anyway, so
 * this is what makes "wiped on sign-out or user change" hold even when
 * the session ends in another tab and no `signOut()` runs here.
 * Returns whether the cache was cleared.
 */
export function noteSessionUser(userId: string | null): boolean {
  if (userId === boundUserId) return false;
  // From nobody to someone: nothing of theirs can be cached yet.
  const changed = boundUserId !== null;
  boundUserId = userId;
  if (!changed) return false;
  sessionCache.clear();
  return true;
}

// ------------------------------------------------------------
// Decisions behind `useSessionQuery`, kept pure for tests
// ------------------------------------------------------------

export interface SessionQueryView<T> {
  data: T | undefined;
  /** True only while nothing is cached and the first answer is loading. */
  loading: boolean;
  /** True while a fetch runs behind a value already on screen. */
  refreshing: boolean;
}

/** What the hook shows for a key, from the cache's state. */
export function sessionQueryView<T>(state: {
  active: boolean;
  entry: SessionEntry<T> | undefined;
  fetching: boolean;
  hasError: boolean;
}): SessionQueryView<T> {
  if (!state.active) {
    return { data: undefined, loading: false, refreshing: false };
  }
  if (state.entry) {
    return {
      data: state.entry.value,
      loading: false,
      refreshing: state.fetching,
    };
  }
  // Nothing cached: loading until the first answer (or its failure),
  // and also in the render before the mount effect starts the fetch.
  return {
    data: undefined,
    loading: state.fetching || !state.hasError,
    refreshing: false,
  };
}

/**
 * On mount or key change: show the cached value if any, and always
 * revalidate — joining a fetch in flight rather than starting another.
 */
export function planSessionMount<T>(state: {
  entry: SessionEntry<T> | undefined;
  fetching: boolean;
}): { show: T | undefined; revalidate: true; joinInflight: boolean } {
  return {
    show: state.entry?.value,
    revalidate: true,
    joinInflight: state.fetching,
  };
}

/**
 * Whether a settled fetch may change the hook's own state (its error).
 * The cache stores every answer under its own key; the hook only
 * reacts to the key it is currently showing, so a slow answer for the
 * chat just left never lands on the one opened after it.
 */
export function isCurrentRequest(
  requestKey: SessionKey,
  currentKey: SessionKey | null
): boolean {
  return requestKey === currentKey;
}

/** For tests only: forget the bound user as well as every entry. */
export function resetSessionCacheForTests(): void {
  sessionCache.clear();
  listeners.clear();
  boundUserId = null;
}
