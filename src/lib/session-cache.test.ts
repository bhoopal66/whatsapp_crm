import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_CACHE_MAX_ENTRIES,
  type SessionKey,
  isCurrentRequest,
  noteSessionUser,
  planSessionMount,
  prefetchSession,
  resetSessionCacheForTests,
  sessionCache,
  sessionKey,
  sessionQueryView,
  shouldStoreFetchResult,
} from './session-cache';

function key(question: string, account = 'acct-1', user = 'user-1') {
  return sessionKey(account, user, question) as SessionKey;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetSessionCacheForTests();
});

describe('sessionKey', () => {
  it('keeps account, user and question apart', () => {
    const keys = new Set([
      key('inbox'),
      key('inbox', 'acct-2'),
      key('inbox', 'acct-1', 'user-2'),
      key('contacts'),
    ]);
    expect(keys.size).toBe(4);

    sessionCache.set(key('inbox'), 'mine');
    expect(sessionCache.get(key('inbox', 'acct-2'))).toBeUndefined();
    expect(sessionCache.get(key('inbox', 'acct-1', 'user-2'))).toBeUndefined();
    expect(sessionCache.get(key('inbox'))?.value).toBe('mine');
  });

  it('builds no key without both account and user', () => {
    expect(sessionKey(null, 'user-1', 'inbox')).toBeNull();
    expect(sessionKey('acct-1', undefined, 'inbox')).toBeNull();
    expect(sessionKey('', 'user-1', 'inbox')).toBeNull();
  });
});

describe('sessionCache', () => {
  it('stores the value with the time it was stored', () => {
    sessionCache.set(key('a'), [1], 1234);
    expect(sessionCache.get(key('a'))).toEqual({ value: [1], storedAt: 1234 });
  });

  it('evicts the least recently used entry past the bound', () => {
    for (let i = 0; i < SESSION_CACHE_MAX_ENTRIES; i++) {
      sessionCache.set(key(`q${i}`), i);
    }
    // Reading q0 makes q1 the least recently used.
    sessionCache.get(key('q0'));
    sessionCache.set(key('new'), 'n');

    expect(sessionCache.size()).toBe(SESSION_CACHE_MAX_ENTRIES);
    expect(sessionCache.peek(key('q0'))).toBeDefined();
    expect(sessionCache.peek(key('q1'))).toBeUndefined();
    expect(sessionCache.peek(key('q2'))).toBeDefined();
    expect(sessionCache.peek(key('new'))).toBeDefined();
  });

  it('never evicts a key a mounted screen is showing', () => {
    for (let i = 0; i < SESSION_CACHE_MAX_ENTRIES; i++) {
      sessionCache.set(key(`q${i}`), i);
    }
    const stop = sessionCache.subscribe(key('q0'), () => {});
    sessionCache.set(key('new'), 'n');

    expect(sessionCache.peek(key('q0'))).toBeDefined();
    expect(sessionCache.peek(key('q1'))).toBeUndefined();
    stop();
  });

  it('notifies subscribers of set, update and delete on their key only', () => {
    const listener = vi.fn();
    const other = vi.fn();
    sessionCache.subscribe(key('a'), listener);
    sessionCache.subscribe(key('b'), other);

    sessionCache.set(key('a'), [1]);
    expect(
      sessionCache.update<number[]>(key('a'), (prev) => [...prev, 2])
    ).toBe(true);
    expect(sessionCache.peek(key('a'))?.value).toEqual([1, 2]);
    sessionCache.delete(key('a'));

    expect(listener).toHaveBeenCalledTimes(3);
    expect(other).not.toHaveBeenCalled();
  });

  it('leaves a key with nothing cached alone on update', () => {
    const listener = vi.fn();
    sessionCache.subscribe(key('a'), listener);
    const fn = vi.fn((prev: number) => prev + 1);

    expect(sessionCache.update(key('a'), fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(sessionCache.peek(key('a'))).toBeUndefined();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const stop = sessionCache.subscribe(key('a'), listener);
    stop();
    sessionCache.set(key('a'), 1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('deletes every key under a prefix and notifies each', () => {
    const listener = vi.fn();
    sessionCache.subscribe(key('messages:c1'), listener);
    sessionCache.set(key('messages:c1'), 1);
    sessionCache.set(key('messages:c2'), 2);
    sessionCache.set(key('inbox'), 3);
    listener.mockClear();

    sessionCache.deletePrefix(key('messages:'));

    expect(sessionCache.peek(key('messages:c1'))).toBeUndefined();
    expect(sessionCache.peek(key('messages:c2'))).toBeUndefined();
    expect(sessionCache.peek(key('inbox'))?.value).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear empties everything and notifies', () => {
    const listener = vi.fn();
    sessionCache.subscribe(key('a'), listener);
    sessionCache.set(key('a'), 1);
    sessionCache.set(key('b', 'acct-2', 'user-2'), 2);
    listener.mockClear();

    sessionCache.clear();

    expect(sessionCache.size()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('prefetchSession', () => {
  it('makes one request for two prefetches of one key', async () => {
    const d = deferred<string>();
    const fetcher = vi.fn(() => d.promise);

    const first = prefetchSession(key('a'), fetcher);
    const second = prefetchSession(key('a'), fetcher);
    expect(sessionCache.isFetching(key('a'))).toBe(true);
    d.resolve('answer');

    expect(await first).toBe('answer');
    expect(await second).toBe('answer');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionCache.peek(key('a'))?.value).toBe('answer');
    expect(sessionCache.isFetching(key('a'))).toBe(false);
  });

  it('fetches again once the first request has settled', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await prefetchSession(key('a'), fetcher);
    await prefetchSession(key('a'), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sessionCache.peek(key('a'))?.value).toBe(2);
  });

  it('keeps the cached value when a refresh fails', async () => {
    sessionCache.set(key('a'), 'seen');
    await expect(
      prefetchSession(key('a'), () => Promise.reject(new Error('offline')))
    ).rejects.toThrow('offline');
    expect(sessionCache.peek(key('a'))?.value).toBe('seen');
    expect(sessionCache.isFetching(key('a'))).toBe(false);
  });

  it('lets a forced fetch win over an older one that settles later', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const a = prefetchSession(key('a'), () => older.promise);
    const b = prefetchSession(key('a'), () => newer.promise, { force: true });

    newer.resolve('new');
    await b;
    older.resolve('old');
    await a;

    expect(sessionCache.peek(key('a'))?.value).toBe('new');
  });

  it('does not write back an answer that started before a clear', async () => {
    const d = deferred<string>();
    const pending = prefetchSession(key('a'), () => d.promise);

    sessionCache.clear();
    d.resolve('signed-out user data');
    await pending;

    expect(sessionCache.peek(key('a'))).toBeUndefined();
    expect(sessionCache.isFetching(key('a'))).toBe(false);
  });

  it('notifies subscribers when fetching starts and stops', async () => {
    const listener = vi.fn();
    sessionCache.subscribe(key('a'), listener);
    await prefetchSession(key('a'), async () => 1);
    // start, the stored answer, done
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('shouldStoreFetchResult', () => {
  it('stores only the fetch still in flight for the key', () => {
    expect(shouldStoreFetchResult({ seq: 2, latestSeq: 2 })).toBe(true);
    expect(shouldStoreFetchResult({ seq: 1, latestSeq: 2 })).toBe(false);
    // clear() dropped it
    expect(shouldStoreFetchResult({ seq: 2, latestSeq: undefined })).toBe(
      false
    );
  });
});

describe('noteSessionUser', () => {
  it('clears on sign-out and on a different user, not on first sign-in', () => {
    sessionCache.set(key('a'), 1);
    expect(noteSessionUser('user-1')).toBe(false);
    expect(noteSessionUser('user-1')).toBe(false);
    expect(sessionCache.size()).toBe(1);

    expect(noteSessionUser('user-2')).toBe(true);
    expect(sessionCache.size()).toBe(0);

    sessionCache.set(key('a', 'acct-1', 'user-2'), 2);
    expect(noteSessionUser(null)).toBe(true);
    expect(sessionCache.size()).toBe(0);
  });
});

describe('hook decisions', () => {
  it('shows a cached value at once and still revalidates', () => {
    const entry = { value: ['chat'], storedAt: 0 };
    expect(planSessionMount({ entry, fetching: false })).toEqual({
      show: ['chat'],
      revalidate: true,
      joinInflight: false,
    });
    expect(planSessionMount({ entry: undefined, fetching: true })).toEqual({
      show: undefined,
      revalidate: true,
      joinInflight: true,
    });
  });

  it('drops a result whose key is no longer current', () => {
    expect(isCurrentRequest(key('chat:1'), key('chat:2'))).toBe(false);
    expect(isCurrentRequest(key('chat:1'), null)).toBe(false);
    expect(isCurrentRequest(key('chat:1'), key('chat:1'))).toBe(true);
  });

  it('is loading only while nothing is cached', () => {
    const entry = { value: 1, storedAt: 0 };
    expect(
      sessionQueryView({ active: true, entry, fetching: true, hasError: false })
    ).toEqual({ data: 1, loading: false, refreshing: true });
    expect(
      sessionQueryView({
        active: true,
        entry: undefined,
        fetching: true,
        hasError: false,
      })
    ).toEqual({ data: undefined, loading: true, refreshing: false });
    expect(
      sessionQueryView({
        active: true,
        entry: undefined,
        fetching: false,
        hasError: true,
      })
    ).toEqual({ data: undefined, loading: false, refreshing: false });
    expect(
      sessionQueryView({
        active: false,
        entry,
        fetching: true,
        hasError: false,
      })
    ).toEqual({ data: undefined, loading: false, refreshing: false });
  });
});

describe('never persisted', () => {
  it('does not touch web storage or IndexedDB', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('./session-cache.ts', import.meta.url),
      'utf8'
    )
      // Comments may name what is avoided.
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie/i
    );
  });
});
