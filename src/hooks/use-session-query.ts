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
  planSessionMount,
  prefetchSession,
  sessionCache,
  sessionQueryView,
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
 */
export function useSessionQuery<T>(
  key: SessionKey | null,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean } = {}
): SessionQueryResult<T> {
  const enabled = options.enabled ?? true;
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

  // The error belongs to the key it was raised for, so a failure of the
  // chat just left never shows on the next one.
  const [failure, setFailure] = useState<{
    key: SessionKey;
    error: unknown;
  } | null>(null);
  const error = failure && failure.key === activeKey ? failure.error : null;

  const run = useCallback((requestKey: SessionKey, force: boolean) => {
    return prefetchSession(requestKey, () => fetcherRef.current(), {
      force,
    }).then(
      () => {
        if (isCurrentRequest(requestKey, keyRef.current)) setFailure(null);
      },
      (err: unknown) => {
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
    if (plan.revalidate) void run(activeKey, false);
  }, [activeKey, run]);

  const refresh = useCallback(async () => {
    if (activeKey) await run(activeKey, true);
  }, [activeKey, run]);

  const view = sessionQueryView({
    active: activeKey !== null,
    entry,
    fetching,
    hasError: error !== null,
  });
  return { ...view, error, refresh };
}
