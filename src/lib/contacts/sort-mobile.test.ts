import { describe, expect, it } from 'vitest';
import { flipContactSortDir, mobileSortKeys, pickContactSortKey } from './sort';

describe('mobileSortKeys', () => {
  it('always offers Name, then the shown columns in header order', () => {
    expect(
      mobileSortKeys({
        owner: true,
        assignee: true,
        activity: true,
        created: true,
      })
    ).toEqual(['name', 'owner', 'assignee', 'activity', 'created']);
    expect(
      mobileSortKeys({
        owner: false,
        assignee: false,
        activity: false,
        created: false,
      })
    ).toEqual(['name']);
    expect(
      mobileSortKeys({
        owner: false,
        assignee: true,
        activity: false,
        created: true,
      })
    ).toEqual(['name', 'assignee', 'created']);
  });
});

describe('pickContactSortKey', () => {
  it('keeps the direction when the same key is picked again', () => {
    const s = { sort: 'name', dir: 'desc' } as const;
    expect(pickContactSortKey(s, 'name')).toBe(s);
  });

  it('starts a new key in its default direction', () => {
    const s = { sort: 'name', dir: 'desc' } as const;
    expect(pickContactSortKey(s, 'created')).toEqual({
      sort: 'created',
      dir: 'desc',
    });
    expect(
      pickContactSortKey({ sort: 'created', dir: 'desc' }, 'name')
    ).toEqual({ sort: 'name', dir: 'asc' });
  });
});

describe('flipContactSortDir', () => {
  it('reverses the direction and keeps the key', () => {
    expect(flipContactSortDir({ sort: 'owner', dir: 'asc' })).toEqual({
      sort: 'owner',
      dir: 'desc',
    });
    expect(flipContactSortDir({ sort: 'created', dir: 'desc' })).toEqual({
      sort: 'created',
      dir: 'asc',
    });
  });
});
