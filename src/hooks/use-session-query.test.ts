import { beforeEach, describe, expect, it, vi } from 'vitest';

// The test environment has no DOM, so React's hooks are stood in for
// by a one-component renderer: `render()` calls the hook once, state,
// refs and callbacks keep their slot between renders, and an effect
// runs at once when its dependencies changed (as on mount). A state
// setter stores the value for the next `render()`; an external store
// is read through its snapshot.
const react = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));

function slot<T>(init: () => T): { value: T } {
  const i = react.index++;
  if (!(i in react.slots)) react.slots[i] = { value: init() };
  return react.slots[i] as { value: T };
}

function depsChanged(prev: unknown[] | undefined, next?: unknown[]) {
  return !prev || !next || next.some((dep, i) => !Object.is(dep, prev[i]));
}

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => {
    const s = slot(() =>
      typeof init === 'function' ? (init as () => unknown)() : init
    );
    return [
      s.value,
      (next: unknown) => {
        s.value =
          typeof next === 'function'
            ? (next as (prev: unknown) => unknown)(s.value)
            : next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const s = slot<unknown[] | undefined>(() => undefined);
    if (depsChanged(s.value, deps) || s.value === undefined) {
      s.value = deps ?? [];
      effect();
    }
  },
  useCallback: (fn: unknown, deps?: unknown[]) => {
    const s = slot<{ fn: unknown; deps?: unknown[] } | undefined>(
      () => undefined
    );
    if (!s.value || depsChanged(s.value.deps, deps)) s.value = { fn, deps };
    return s.value.fn;
  },
  useRef: (value: unknown) => slot(() => ({ current: value })).value,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
    getSnapshot(),
}));

function render<T>(hook: () => T): T {
  react.index = 0;
  return hook();
}

import {
  type SessionKey,
  leaveSession,
  noteSessionUser,
  prefetchSession,
  resetSessionCacheForTests,
  sessionCache,
  sessionKey,
} from '@/lib/session-cache';
import { useSessionQuery } from './use-session-query';

const KEY = sessionKey('acct-1', 'user-1', 'inbox:list') as SessionKey;

beforeEach(() => {
  resetSessionCacheForTests();
  react.slots = [];
  react.index = 0;
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

  it('re-reads a shown key whose entry was deleted', async () => {
    sessionCache.set(KEY, ['last seen']);
    const fetcher = vi.fn(async () => ['fresh']);
    render(() => useSessionQuery(KEY, fetcher));
    await vi.waitFor(() => expect(sessionCache.isFetching(KEY)).toBe(false));

    sessionCache.delete(KEY);
    render(() => useSessionQuery(KEY, fetcher));

    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(sessionCache.peek(KEY)?.value).toEqual(['fresh'])
    );
  });

  it('re-reads a first load that clear() dropped under the same key', async () => {
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(['fresh']);
    render(() => useSessionQuery(KEY, fetcher));

    sessionCache.clear();
    const shown = render(() => useSessionQuery(KEY, fetcher));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(shown.loading).toBe(true);
    await vi.waitFor(() =>
      expect(sessionCache.peek(KEY)?.value).toEqual(['fresh'])
    );
  });

  it('does not re-read the shown key after the page starts leaving', async () => {
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(['new workspace rows']);
    render(() => useSessionQuery(KEY, fetcher));

    leaveSession();
    const shown = render(() => useSessionQuery(KEY, fetcher));
    await new Promise((settled) => setTimeout(settled, 0));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionCache.peek(KEY)).toBeUndefined();
    expect(shown.error).toBeNull();
  });

  it('does not re-read a key of the previous user after a user change', async () => {
    noteSessionUser('user-1');
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(['user-2 rows']);
    render(() => useSessionQuery(KEY, fetcher));

    noteSessionUser('user-2');
    render(() => useSessionQuery(KEY, fetcher));
    await new Promise((settled) => setTimeout(settled, 0));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionCache.peek(KEY)).toBeUndefined();
  });

  it('does not retry a failed first load on re-render', async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error('offline')));
    render(() => useSessionQuery(KEY, fetcher));
    await new Promise((settled) => setTimeout(settled, 0));

    const shown = render(() => useSessionQuery(KEY, fetcher));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(shown.loading).toBe(false);
    expect(shown.error).toBeInstanceOf(Error);
  });

  describe('reread', () => {
    const settle = () => new Promise((settled) => setTimeout(settled, 0));

    it('rejects when the read failed, and shows none behind cached data', async () => {
      sessionCache.set(KEY, ['held']);
      const fetcher = vi.fn(async () => ['held']);
      const query = render(() => useSessionQuery(KEY, fetcher));
      await settle();

      fetcher.mockRejectedValueOnce(new Error('503'));
      await expect(query.reread()).rejects.toThrow('503');

      const shown = render(() => useSessionQuery(KEY, fetcher));
      expect(shown).toMatchObject({ data: ['held'], error: null });
    });

    it('keeps the first failure of an empty entry, and clears it once read', async () => {
      const first = new Error('first');
      const fetcher = vi.fn(async (): Promise<string[]> => {
        throw first;
      });
      const query = render(() => useSessionQuery(KEY, fetcher));
      await settle();
      fetcher.mockRejectedValueOnce(new Error('second'));
      await expect(query.reread()).rejects.toThrow('second');
      expect(render(() => useSessionQuery(KEY, fetcher)).error).toBe(first);

      fetcher.mockResolvedValueOnce(['read']);
      await query.reread();
      const shown = render(() => useSessionQuery(KEY, fetcher));
      expect(shown).toMatchObject({ data: ['read'], error: null });
    });

    it('records a failure when nothing is cached', async () => {
      const held = new Promise<string[]>(() => {});
      const fetcher = vi.fn(() => held);
      const query = render(() => useSessionQuery(KEY, fetcher));
      fetcher.mockRejectedValueOnce(new Error('503'));
      await expect(query.reread()).rejects.toThrow('503');
      const shown = render(() => useSessionQuery(KEY, fetcher));
      expect(shown.error).toBeInstanceOf(Error);
    });

    it('is quiet for a key of a session this tab has left', async () => {
      const fetcher = vi.fn(async () => 1);
      const query = render(() => useSessionQuery(KEY, fetcher));
      await settle();
      leaveSession();
      await expect(query.reread()).resolves.toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});
