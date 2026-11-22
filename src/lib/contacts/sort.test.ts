import { describe, expect, it } from 'vitest';
import {
  ariaSortFor,
  compareContactRows,
  CONTACT_SORT_KEYS,
  DEFAULT_CONTACT_SORT,
  defaultDir,
  effectiveContactSort,
  isServerSortKey,
  nextContactSort,
  parseContactSort,
  SERVER_SORT_KEYS,
  sortToParams,
} from './sort';

describe('parseContactSort', () => {
  it('falls back on unknown keys', () => {
    expect(parseContactSort('ownr', 'asc')).toEqual(DEFAULT_CONTACT_SORT);
    expect(parseContactSort('created_at', 'asc')).toEqual(DEFAULT_CONTACT_SORT);
    expect(parseContactSort(null, null)).toEqual(DEFAULT_CONTACT_SORT);
  });
  it('defaults the direction per key', () => {
    expect(parseContactSort('name', 'sideways')).toEqual({
      sort: 'name',
      dir: 'asc',
    });
    expect(parseContactSort('created', null).dir).toBe('desc');
  });
  it('reads owner, assignee and activity from the URL', () => {
    expect(parseContactSort('owner', 'desc')).toEqual({
      sort: 'owner',
      dir: 'desc',
    });
    expect(parseContactSort('assignee', null)).toEqual({
      sort: 'assignee',
      dir: 'asc',
    });
    expect(parseContactSort('activity', undefined)).toEqual({
      sort: 'activity',
      dir: 'desc',
    });
  });
  it('round-trips every key and direction through the URL params', () => {
    for (const key of CONTACT_SORT_KEYS) {
      for (const dir of ['asc', 'desc'] as const) {
        const params = sortToParams({ sort: key, dir });
        expect(parseContactSort(params.sort, params.dir)).toEqual({
          sort: key,
          dir,
        });
      }
    }
  });
});

describe('server sort keys', () => {
  it('are owner, assignee and activity only', () => {
    expect([...SERVER_SORT_KEYS]).toEqual(['owner', 'assignee', 'activity']);
    expect(CONTACT_SORT_KEYS.filter(isServerSortKey)).toEqual([
      'owner',
      'assignee',
      'activity',
    ]);
    expect(isServerSortKey('name')).toBe(false);
    expect(isServerSortKey('created')).toBe(false);
  });
  it('start names A to Z and dates newest first', () => {
    expect(defaultDir('owner')).toBe('asc');
    expect(defaultDir('assignee')).toBe('asc');
    expect(defaultDir('activity')).toBe('desc');
  });
  it('fall back to the default order without the RPC', () => {
    const owner = { sort: 'owner', dir: 'asc' } as const;
    expect(effectiveContactSort(owner, true)).toEqual(owner);
    expect(effectiveContactSort(owner, false)).toEqual(DEFAULT_CONTACT_SORT);
    const name = { sort: 'name', dir: 'desc' } as const;
    expect(effectiveContactSort(name, false)).toEqual(name);
  });
});

describe('nextContactSort', () => {
  it('flips on the same key and resets on a new one', () => {
    const a = nextContactSort(DEFAULT_CONTACT_SORT, 'created');
    expect(a.dir).toBe('asc');
    expect(nextContactSort(a, 'name')).toEqual({ sort: 'name', dir: 'asc' });
  });
});

describe('url + aria', () => {
  it('omits the default', () => {
    expect(sortToParams(DEFAULT_CONTACT_SORT)).toEqual({});
    expect(sortToParams({ sort: 'name', dir: 'desc' })).toEqual({
      sort: 'name',
      dir: 'desc',
    });
  });
  it('reports aria-sort', () => {
    const s = { sort: 'name', dir: 'asc' } as const;
    expect(ariaSortFor(s, 'name')).toBe('ascending');
    expect(ariaSortFor(s, 'created')).toBe('none');
  });
});

describe('compareContactRows', () => {
  const rows = [
    { id: 'a', created_at: '2026-01-01', name: 'bob' },
    { id: 'b', created_at: '2026-01-02', name: '' },
    { id: 'c', created_at: '2026-01-03', name: 'Alice' },
  ];
  it('sorts names case-insensitively with blanks last', () => {
    const asc = [...rows].sort(
      compareContactRows({ sort: 'name', dir: 'asc' })
    );
    expect(asc.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    const desc = [...rows].sort(
      compareContactRows({ sort: 'name', dir: 'desc' })
    );
    expect(desc.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
  it('sorts by created', () => {
    const asc = [...rows].sort(
      compareContactRows({ sort: 'created', dir: 'asc' })
    );
    expect(asc.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('orders a server-only key as the default (its fallback), both ways', () => {
    for (const dir of ['asc', 'desc'] as const) {
      const sorted = [...rows].sort(compareContactRows({ sort: 'owner', dir }));
      expect(sorted.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    }
  });
});

describe('header clicks and aria-sort on the new keys', () => {
  it('starts each key at its default and flips on a second click', () => {
    const a = nextContactSort(DEFAULT_CONTACT_SORT, 'activity');
    expect(a).toEqual({ sort: 'activity', dir: 'desc' });
    expect(nextContactSort(a, 'activity')).toEqual({
      sort: 'activity',
      dir: 'asc',
    });
    expect(nextContactSort(a, 'assignee')).toEqual({
      sort: 'assignee',
      dir: 'asc',
    });
  });
  it('reports aria-sort for the active key only', () => {
    const s = { sort: 'owner', dir: 'desc' } as const;
    expect(ariaSortFor(s, 'owner')).toBe('descending');
    expect(ariaSortFor(s, 'assignee')).toBe('none');
    expect(ariaSortFor(s, 'name')).toBe('none');
  });
});
