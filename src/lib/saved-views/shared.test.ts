import { describe, expect, it } from 'vitest';
import { sharedViewFilters, splitKnownTags } from './types';

describe('sharedViewFilters', () => {
  it('blanks the search and drops the column choice', () => {
    const out = sharedViewFilters({
      search: 'Ahmed 0501234567',
      hiddenColumns: ['email'],
      chatTagIds: ['a'],
    });
    expect(out).toEqual({ search: '', chatTagIds: ['a'] });
  });
  it('adds no search key to a view that has none', () => {
    expect(sharedViewFilters({ unread: true })).toEqual({ unread: true });
  });
});

describe('splitKnownTags', () => {
  it('counts the tags that no longer exist', () => {
    const r = splitKnownTags(['a', 'b', 'c'], (id) => id === 'a');
    expect(r).toEqual({ kept: ['a'], missing: 2 });
  });
  it('reports none missing when all exist', () => {
    expect(splitKnownTags(['a'], () => true)).toEqual({
      kept: ['a'],
      missing: 0,
    });
  });
});
