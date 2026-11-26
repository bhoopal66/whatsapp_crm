'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  isCurrentRequest,
  mayFetchSessionKey,
  planSessionMount,
  prefetchSession,
  sessionCache,
  SessionScopeError,
  sessionQueryView,
  shouldRevalidateAfterWipe,
  type PrefetchOptions,
  type SessionEntry,
  type SessionKey,
} from '@/lib/session-cache';

export interface SessionQueryResult<T> {
  data: T | undefined;
  /** True only when nothing is cached for the key yet. */
  loading: boolean;
  /** True while a background refresh runs behind cached data. */
  refreshing: boolean;
  error: unknown;
  /** Fetch again now, even if a fetch is already running. */
  refresh: () => Promise<void>;
  /**
   * `refresh` for a caller that retries (a catch-up): it rejects when
   * the read failed, and records that only when nothing is cached and
   * no failure is recorded yet, so its retries are quiet.
   */
  reread: () => Promise<void>;
}

const noopUnsubscribe = () => {};

/**
 * Screen data that shows what the user last saw at once and refreshes
 * it in the background (`lib/session-cache.ts` states the rule).
 *
 * `key` null means "not yet" (account or user unknown): nothing is
 * shown or fetched. Every mount and key change revalidates, sharing a
 * fetch already in flight (a hover prefetch). Components on the same
 * key see the same data, and `sessionCache.update(key, …)` from a
 * realtime handler re-renders all of them.
 *
 * `fetcher` may be an inline function; the latest one is used.
 * `keepLocalWrites` is `prefetchSession`'s opt-in, for a screen that
 * patches its entry optimistically while a revalidate may be running.
 */
export function useSessionQuery<T>(
  key: SessionKey | null,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean; keepLocalWrites?: boolean } = {}
): SessionQueryResult<T> {
  const enabled = options.enabled ?? true;
  const keepLocalWrites = options.keepLocalWrites ?? false;
  const activeKey = enabled ? key : null;

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const keyRef = useRef(activeKey);
  useEffect(() => {
    keyRef.current = activeKey;
  });

  const subscribe = useCallback(
    (onChange: () => void) =>
      activeKey ? sessionCache.subscribe(activeKey, onChange) : noopUnsubscribe,
    [activeKey]
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (activeKey ? sessionCache.peek<T>(activeKey) : undefined),
    () => undefined as SessionEntry<T> | undefined
  );
  const fetching = useSyncExternalStore(
    subscribe,
    () => (activeKey ? sessionCache.isFetching(activeKey) : false),
    () => false
  );
  const wipes = useSyncExternalStore(
    subscribe,
    () => sessionCache.wipeCount(),
    () => 0
  );

  // The error belongs to the key it was raised for, so a failure of the
  // chat just left never shows on the next one.
  const [failure, setFailure] = useState<{
    key: SessionKey;
    error: unknown;
  } | null>(null);
  const error = failure && failure.key === activeKey ? failure.error : null;

  const run = useCallback((requestKey: SessionKey, opts: PrefetchOptions) => {
    return prefetchSession(requestKey, () => fetcherRef.current(), opts).then(
      () => {
        if (isCurrentRequest(requestKey, keyRef.current)) setFailure(null);
      },
      (err: unknown) => {
        // A key of a session this tab has left is not an error to show:
        // the page is navigating away, or about to get its new key.
        if (err instanceof SessionScopeError) return;
        if (isCurrentRequest(requestKey, keyRef.current)) {
          setFailure({ key: requestKey, error: err });
        }
      }
    );
  }, []);

  useEffect(() => {
    if (!activeKey) return;
    keyRef.current = activeKey;
    // Cached or not, always revalidate; prefetchSession joins a fetch
    // already in flight, so a hover prefetch is not repeated.
    const plan = planSessionMount({
      entry: sessionCache.get(activeKey),
      fetching: sessionCache.isFetching(activeKey),
    });
    if (plan.revalidate) void run(activeKey, { keepLocalWrites });
  }, [activeKey, run, keepLocalWrites]);

  // A wipe (`delete`, `deletePrefix`, or a `clear()` that dropped the
  // first fetch) can leave the shown key with nothing cached and nothing
  // fetching: read it again rather than leave the skeleton up — unless
  // the wipe ended the key's session (sign-out, switch, user change),
  // when a read would store the new session's rows under the old key.
  // A failed fetch is no wipe and leaves an error, so it is never
  // retried in a loop.
  const hasError = error !== null;
  useEffect(() => {
    if (!activeKey) return;
    if (
      shouldRevalidateAfterWipe({
        active: true,
        entry: sessionCache.peek(activeKey),
        fetching: sessionCache.isFetching(activeKey),
        hasError,
        fetchAllowed: mayFetchSessionKey(activeKey),
      })
    ) {
      void run(activeKey, { keepLocalWrites });
    }
  }, [activeKey, wipes, hasError, run, keepLocalWrites]);

  const refresh = useCallback(async () => {
    if (activeKey) await run(activeKey, { force: true, keepLocalWrites });
  }, [activeKey, run, keepLocalWrites]);

  const reread = useCallback(async () => {
    if (!activeKey) return;
    const current = () => isCurrentRequest(activeKey, keyRef.current);
    try {
      await prefetchSession(activeKey, () => fetcherRef.current(), {
        force: true,
        keepLocalWrites,
      });
    } catch (err) {
      if (err instanceof SessionScopeError) return;
      if (current() && !sessionCache.peek(activeKey)) {
        setFailure((f) =>
          f?.key === activeKey ? f : { key: activeKey, error: err }
        );
      }
      throw err;
    }
    if (current()) setFailure(null);
  }, [activeKey, keepLocalWrites]);

  const view = sessionQueryView({
    active: activeKey !== null,
    entry,
    fetching,
    hasError: error !== null,
  });
  return { ...view, error, refresh, reread };
}
