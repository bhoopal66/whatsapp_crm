import { beforeEach, describe, expect, it, vi } from 'vitest';

// The test environment has no DOM, so React's hooks are stood in for:
// state is its initial value, an effect runs at once, and an external
// store is read through its snapshot. That is enough to check what the
// hook shows on mount and that it always revalidates.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [
    typeof init === 'function' ? (init as () => unknown)() : init,
    () => {},
  ],
  useEffect: (effect: () => void | (() => void)) => {
    effect();
  },
  useCallback: (fn: unknown) => fn,
  useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
    getSnapshot(),
}));

import {
  type SessionKey,
  prefetchSession,
  resetSessionCacheForTests,
  sessionCache,
  sessionKey,
} from '@/lib/session-cache';
import { useSessionQuery } from './use-session-query';

const KEY = sessionKey('acct-1', 'user-1', 'inbox:list') as SessionKey;

beforeEach(() => {
  resetSessionCacheForTests();
});

describe('useSessionQuery', () => {
  it('shows the cached value at once and revalidates it', async () => {
    sessionCache.set(KEY, ['last seen']);
    let resolve!: (value: string[]) => void;
    const fetcher = vi.fn(
      () => new Promise<string[]>((res) => (resolve = res))
    );

    const result = useSessionQuery(KEY, fetcher);

    expect(result.data).toEqual(['last seen']);
    expect(result.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionCache.isFetching(KEY)).toBe(true);

    resolve(['fresh']);
    await vi.waitFor(() =>
      expect(sessionCache.peek(KEY)?.value).toEqual(['fresh'])
    );
  });

  it('is loading when nothing is cached', () => {
    const result = useSessionQuery(KEY, () => new Promise(() => {}));
    expect(result.data).toBeUndefined();
    expect(result.loading).toBe(true);
  });

  it('joins a prefetch already in flight', async () => {
    const prefetcher = vi.fn(() => new Promise<number>(() => {}));
    void prefetchSession(KEY, prefetcher);
    const fetcher = vi.fn(() => Promise.resolve(1));

    useSessionQuery(KEY, fetcher);

    expect(prefetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches nothing without a key or when disabled', () => {
    const fetcher = vi.fn(() => Promise.resolve(1));
    sessionCache.set(KEY, 'cached');

    expect(useSessionQuery(null, fetcher)).toMatchObject({
      data: undefined,
      loading: false,
    });
    expect(useSessionQuery(KEY, fetcher, { enabled: false })).toMatchObject({
      data: undefined,
      loading: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
