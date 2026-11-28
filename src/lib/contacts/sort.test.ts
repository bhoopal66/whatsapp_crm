import { describe, expect, it } from 'vitest';
import {
  ariaSortFor,
  compareContactRows,
  DEFAULT_CONTACT_SORT,
  nextContactSort,
  parseContactSort,
  sortToParams,
} from './sort';

describe('parseContactSort', () => {
  it('knows the keys ordered by the database', () => {
    expect(parseContactSort('owner', null)).toEqual({
      sort: 'owner',
      dir: 'asc',
    });
    expect(parseContactSort('assigned', 'desc')).toEqual({
      sort: 'assigned',
      dir: 'desc',
    });
    expect(parseContactSort('activity', null)).toEqual({
      sort: 'activity',
      dir: 'desc',
    });
  });
  it('falls back on unknown keys', () => {
    expect(parseContactSort('bogus', 'asc')).toEqual(DEFAULT_CONTACT_SORT);
    expect(parseContactSort(null, null)).toEqual(DEFAULT_CONTACT_SORT);
  });
  it('defaults the direction per key', () => {
    expect(parseContactSort('name', 'sideways')).toEqual({
      sort: 'name',
      dir: 'asc',
    });
    expect(parseContactSort('created', null).dir).toBe('desc');
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
});
