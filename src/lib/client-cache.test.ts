import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MEMBERS_CACHE_KEY,
  cachedQuery,
  clearClientCache,
  invalidateCached,
  membersCacheKey,
} from './client-cache';

describe('cachedQuery', () => {
  beforeEach(() => {
    clearClientCache();
  });

  it('runs the loader once within the TTL', async () => {
    const loader = vi.fn().mockResolvedValue('tags');

    expect(await cachedQuery('tags', 1000, loader, 0)).toBe('tags');
    expect(await cachedQuery('tags', 1000, loader, 999)).toBe('tags');

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads once the TTL has passed', async () => {
    const loader = vi.fn().mockResolvedValue('tags');

    await cachedQuery('tags', 1000, loader, 0);
    await cachedQuery('tags', 1000, loader, 1001);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between simultaneous callers', async () => {
    // The point of caching the promise rather than the value: two
    // components mounting in the same tick must not fire two requests.
    const loader = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('members'), 5)),
    );

    const [a, b] = await Promise.all([
      cachedQuery('members', 1000, loader, 0),
      cachedQuery('members', 1000, loader, 0),
    ]);

    expect(a).toBe('members');
    expect(b).toBe('members');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failure', async () => {
    // An offline blip must not be cached as the answer for the rest
    // of the TTL — the next caller has to be allowed to retry.
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('tags');

    await expect(cachedQuery('tags', 1000, loader, 0)).rejects.toThrow('offline');
    expect(await cachedQuery('tags', 1000, loader, 1)).toBe('tags');

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keys the answer, so two users on one device do not share it', async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce('alice-team')
      .mockResolvedValueOnce('bob-team');

    expect(await cachedQuery('teams:leader:alice', 1000, loader, 0)).toBe('alice-team');
    expect(await cachedQuery('teams:leader:bob', 1000, loader, 0)).toBe('bob-team');
  });
});

describe('invalidateCached', () => {
  beforeEach(() => {
    clearClientCache();
  });

  it('forces the next read back to the loader', async () => {
    const loader = vi.fn().mockResolvedValue('tags');

    await cachedQuery('tags', 60_000, loader, 0);
    invalidateCached('tags');
    await cachedQuery('tags', 60_000, loader, 1);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidates every key under a prefix', async () => {
    const alice = vi.fn().mockResolvedValue('a');
    const bob = vi.fn().mockResolvedValue('b');

    await cachedQuery('teams:leader:alice', 60_000, alice, 0);
    await cachedQuery('teams:leader:bob', 60_000, bob, 0);
    invalidateCached('teams:');
    await cachedQuery('teams:leader:alice', 60_000, alice, 1);
    await cachedQuery('teams:leader:bob', 60_000, bob, 1);

    expect(alice).toHaveBeenCalledTimes(2);
    expect(bob).toHaveBeenCalledTimes(2);
  });

  it('leaves unrelated keys alone', async () => {
    const tags = vi.fn().mockResolvedValue('tags');
    const teams = vi.fn().mockResolvedValue('teams');

    await cachedQuery('tags', 60_000, tags, 0);
    await cachedQuery('teams:leader:alice', 60_000, teams, 0);
    invalidateCached('tags');
    await cachedQuery('teams:leader:alice', 60_000, teams, 1);

    expect(teams).toHaveBeenCalledTimes(1);
  });
});

describe('membersCacheKey', () => {
  beforeEach(() => {
    clearClientCache();
  });

  it('names the account, so two workspaces never share a roster', async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce('roster-a')
      .mockResolvedValueOnce('roster-b');

    expect(await cachedQuery(membersCacheKey('acc-a'), 1000, loader, 0)).toBe(
      'roster-a',
    );
    expect(await cachedQuery(membersCacheKey('acc-b'), 1000, loader, 0)).toBe(
      'roster-b',
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("is cleared for every account by invalidating MEMBERS_CACHE_KEY", async () => {
    const loader = vi.fn().mockResolvedValue('roster');
    await cachedQuery(membersCacheKey('acc-a'), 1000, loader, 0);
    await cachedQuery(membersCacheKey('acc-b'), 1000, loader, 0);

    invalidateCached(MEMBERS_CACHE_KEY);
    await cachedQuery(membersCacheKey('acc-a'), 1000, loader, 1);
    await cachedQuery(membersCacheKey('acc-b'), 1000, loader, 1);

    expect(loader).toHaveBeenCalledTimes(4);
  });
});
