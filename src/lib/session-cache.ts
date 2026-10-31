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
//   in to this tab (`hooks/use-auth.tsx` calls `leaveSession()` before
//   it navigates, and `noteSessionUser()`). After either, a key of the
//   old session is never fetched again (`sessionFetchAllowed`).
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
  /**
   * How many wipes (`delete`, `deletePrefix`, `clear`) have run in this
   * tab. A screen whose entry a wipe took re-reads it
   * (`shouldRevalidateAfterWipe`); a failed fetch is not a wipe, so a
   * failing read is not retried in a loop.
   */
  wipeCount(): number;
  size(): number;
}

const entries = new Map<SessionKey, SessionEntry>();
const listeners = new Map<SessionKey, Set<Listener>>();
const inflight = new Map<SessionKey, Inflight>();
let fetchSeq = 0;
let wipes = 0;

// Local writes (`set` / `update`: an optimistic edit, a realtime patch)
// are stamped from one counter, so a fetch opted in with
// `keepLocalWrites` can tell one landed while it ran. A fetch's own
// store is not a local write.
let localWriteSeq = 0;
const lastLocalWrite = new Map<SessionKey, number>();

/** Re-reads scheduled because a local write overtook a fetch. */
const scheduled = new Map<SessionKey, ReturnType<typeof setTimeout>>();

/** Delay before re-reading a key whose fetch a local write overtook. */
export const SESSION_LOCAL_WRITE_RETRY_MS = 1_000;
/**
 * Re-reads after an overtaken fetch, at most. Past that the local value
 * stays until the next show revalidates, so a steady stream of local
 * writes cannot turn into a read loop.
 */
export const SESSION_LOCAL_WRITE_RETRIES = 2;

function cancelScheduled(key: SessionKey): void {
  const timer = scheduled.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  scheduled.delete(key);
}

function store(key: SessionKey, value: unknown, now: number): void {
  touch(key, { value, storedAt: now });
  evict();
  notify(key);
}

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
    lastLocalWrite.set(key, ++localWriteSeq);
    store(key, value, now);
  },

  update<T>(key: SessionKey, fn: (prev: T) => T, now: number = Date.now()) {
    const entry = entries.get(key) as SessionEntry<T> | undefined;
    if (!entry) return false;
    lastLocalWrite.set(key, ++localWriteSeq);
    touch(key, { value: fn(entry.value), storedAt: now });
    notify(key);
    return true;
  },

  delete(key: SessionKey) {
    cancelScheduled(key);
    lastLocalWrite.delete(key);
    wipes++;
    if (entries.delete(key)) notify(key);
  },

  deletePrefix(prefix: SessionKey) {
    for (const key of [...scheduled.keys()]) {
      if (key.startsWith(prefix)) cancelScheduled(key);
    }
    for (const key of [...lastLocalWrite.keys()]) {
      if (key.startsWith(prefix)) lastLocalWrite.delete(key);
    }
    wipes++;
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
    // Cancelling the scheduled re-reads stops one from firing after a
    // sign-out and storing the previous user's answer.
    const keys = new Set([...entries.keys(), ...inflight.keys()]);
    for (const timer of scheduled.values()) clearTimeout(timer);
    scheduled.clear();
    lastLocalWrite.clear();
    entries.clear();
    inflight.clear();
    wipes++;
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

  wipeCount() {
    return wipes;
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
 * Whether a fetch opted in with `keepLocalWrites` must not store its
 * answer: a local write to the key landed after the fetch started, so
 * the answer may predate it (a deal dragged while the board reloaded).
 */
export function overtakenByLocalWrite(fetch: {
  startedAfterWrite: number;
  lastLocalWrite: number | undefined;
}): boolean {
  return (fetch.lastLocalWrite ?? 0) > fetch.startedAfterWrite;
}

export interface PrefetchOptions {
  /** Start a new fetch even if one is in flight; its answer wins. */
  force?: boolean;
  /**
   * Opt-in for screens that patch their own entry optimistically: an
   * answer that a local `set` / `update` overtook is not stored (the
   * patch stays on screen), and the key is read again after
   * `SESSION_LOCAL_WRITE_RETRY_MS`, at most `SESSION_LOCAL_WRITE_RETRIES`
   * times, so the entry still converges on the server's answer.
   * Without it, the last fetch to settle wins, as consumers that merge
   * with `peek()` themselves expect.
   */
  keepLocalWrites?: boolean;
}

/**
 * Fetch `key` and store the answer. Joins a fetch already in flight for
 * the key (two prefetches, or a hover prefetch followed by the screen,
 * make one request); `force` starts a new one, whose answer then wins
 * over the older one's. Rejects with the fetcher's error; the cached
 * value, if any, is kept. An answer held back by `keepLocalWrites`
 * resolves with the cached value instead.
 */
export function prefetchSession<T>(
  key: SessionKey,
  fetcher: () => Promise<T>,
  opts: PrefetchOptions = {}
): Promise<T> {
  return startFetch(key, fetcher, opts, 0);
}

function startFetch<T>(
  key: SessionKey,
  fetcher: () => Promise<T>,
  opts: PrefetchOptions,
  retries: number
): Promise<T> {
  // After a wipe the tab may no longer be sure whose key this is: a
  // read now would be answered by RLS for the new session and stored
  // under the old key.
  if (!mayFetchSessionKey(key)) {
    return Promise.reject(new SessionScopeError(key));
  }
  const running = inflight.get(key);
  if (running && !opts.force) return running.promise as Promise<T>;

  // This fetch covers whatever a scheduled re-read would have asked.
  cancelScheduled(key);
  const seq = ++fetchSeq;
  const startedAfterWrite = localWriteSeq;
  const promise = (async () => {
    try {
      const value = await fetcher();
      if (shouldStoreFetchResult({ seq, latestSeq: inflight.get(key)?.seq })) {
        if (
          opts.keepLocalWrites &&
          overtakenByLocalWrite({
            startedAfterWrite,
            lastLocalWrite: lastLocalWrite.get(key),
          })
        ) {
          scheduleReread(key, fetcher, opts, retries);
          const kept = entries.get(key);
          return kept ? (kept.value as T) : value;
        }
        store(key, value, Date.now());
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

function scheduleReread<T>(
  key: SessionKey,
  fetcher: () => Promise<T>,
  opts: PrefetchOptions,
  retries: number
): void {
  if (retries >= SESSION_LOCAL_WRITE_RETRIES) return;
  cancelScheduled(key);
  const timer = setTimeout(() => {
    scheduled.delete(key);
    // Joins a fetch already running rather than adding another.
    startFetch(key, fetcher, { ...opts, force: false }, retries + 1).catch(
      () => {} // a failed background re-read keeps the cached value
    );
  }, SESSION_LOCAL_WRITE_RETRY_MS);
  scheduled.set(key, timer);
}

// ------------------------------------------------------------
// User change without a reload
// ------------------------------------------------------------

/** Undefined until the tab learns who is signed in; null = nobody. */
let boundUserId: string | null | undefined = undefined;
/** Set by `leaveSession()` until the page unloads. */
let leaving = false;

/**
 * Tell the cache who is signed in to this tab. A change of user —
 * including to nobody — empties it. Keys carry the user id anyway, so
 * this is what makes "wiped on sign-out or user change" hold even when
 * the session ends in another tab and no `signOut()` runs here. From
 * then on a key naming anyone else is never fetched
 * (`sessionFetchAllowed`). Returns whether the cache was cleared.
 */
export function noteSessionUser(userId: string | null): boolean {
  if (userId === boundUserId) return false;
  // From nobody to someone: nothing of theirs can be cached yet.
  const changed = boundUserId != null;
  boundUserId = userId;
  if (!changed) return false;
  sessionCache.clear();
  return true;
}

/**
 * Wipe the cache for a page that is about to navigate away (sign-out,
 * workspace switch). The session or the active workspace has already
 * changed server-side while every mounted screen still holds the old
 * keys, so no fetch starts again in this page: a restored page
 * (bfcache) reloads instead (`shouldReloadOnPageShow`).
 */
export function leaveSession(): void {
  leaving = true;
  sessionCache.clear();
}

/** Whether `leaveSession()` ran in this page. */
export function isLeavingSession(): boolean {
  return leaving;
}

/** Raised by `prefetchSession` for a key it may not fetch. */
export class SessionScopeError extends Error {
  constructor(key: SessionKey) {
    super(`session cache: not fetching ${key} for this session`);
    this.name = 'SessionScopeError';
  }
}

/** The user id a `sessionKey` names (ids carry no `:`). */
export function sessionKeyUser(key: SessionKey): string | null {
  return key.split(':')[2] ?? null;
}

/**
 * Whether a key may be fetched: never while the page is leaving, and
 * never for a user other than the one signed in to this tab, once the
 * tab knows who that is. A key of the current user stays fetchable
 * after a wipe, so its screen is not left on its skeleton.
 */
export function sessionFetchAllowed(state: {
  leaving: boolean;
  boundUserId: string | null | undefined;
  keyUserId: string | null;
}): boolean {
  if (state.leaving) return false;
  return (
    state.boundUserId === undefined || state.keyUserId === state.boundUserId
  );
}

/** `sessionFetchAllowed` for `key` in this tab's current state. */
export function mayFetchSessionKey(key: SessionKey): boolean {
  return sessionFetchAllowed({
    leaving,
    boundUserId,
    keyUserId: sessionKeyUser(key),
  });
}

/** A page restored from bfcache after `leaveSession()` reloads. */
export function shouldReloadOnPageShow(state: {
  persisted: boolean;
  leaving: boolean;
}): boolean {
  return state.persisted && state.leaving;
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
 * After a wipe: whether the shown key is stuck loading, its entry (or
 * its first fetch, dropped by `clear()`) gone with nothing fetching and
 * no error to show, so the hook must read it again — but only a key
 * this tab may still fetch (`sessionFetchAllowed`). After a sign-out,
 * switch or user change the shown key is the old session's, and a read
 * under it would store the new session's rows there.
 */
export function shouldRevalidateAfterWipe<T>(state: {
  active: boolean;
  entry: SessionEntry<T> | undefined;
  fetching: boolean;
  hasError: boolean;
  fetchAllowed: boolean;
}): boolean {
  return (
    state.active &&
    state.fetchAllowed &&
    !state.entry &&
    !state.fetching &&
    !state.hasError
  );
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
  boundUserId = undefined;
  leaving = false;
}
