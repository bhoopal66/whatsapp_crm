import { describe, expect, it } from 'vitest';
import {
  EMPTY_VIEW_FILTERS,
  fromViewFilters,
  sameViewFilters,
  toViewFilters,
} from './view-filters';

describe('toViewFilters', () => {
  it('copies, trims and normalises the page state', () => {
    expect(
      toViewFilters({
        search: ' ali ',
        chatTagIds: ['b', 'a', 'a'],
        sources: ['web_form', 'ghost', 'ad'],
        sort: { sort: 'name', dir: 'desc' },
        hiddenColumns: ['email'],
        personalOnly: false,
      })
    ).toEqual({
      search: 'ali',
      chatTagIds: ['a', 'b'],
      sources: ['ad', 'web_form'],
      sort: 'name',
      dir: 'desc',
      hiddenColumns: ['email'],
      personalOnly: false,
    });
  });
  it('leaves optional keys out when absent', () => {
    const v = toViewFilters({
      search: '',
      chatTagIds: [],
      sources: [],
      sort: { sort: 'created', dir: 'desc' },
    });
    expect(v).toEqual(EMPTY_VIEW_FILTERS);
    expect('hiddenColumns' in v).toBe(false);
  });
});

describe('fromViewFilters', () => {
  it('round-trips a valid view', () => {
    const v = toViewFilters({
      search: 'x',
      chatTagIds: ['t1'],
      sources: ['import'],
      sort: { sort: 'name', dir: 'asc' },
      hiddenColumns: ['company', 'owner'],
    });
    expect(fromViewFilters(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
  it('is defensive about anything else', () => {
    expect(fromViewFilters(null)).toEqual(EMPTY_VIEW_FILTERS);
    expect(fromViewFilters('x')).toEqual(EMPTY_VIEW_FILTERS);
    expect(fromViewFilters([])).toEqual(EMPTY_VIEW_FILTERS);
    expect(
      fromViewFilters({
        search: 5,
        chatTagIds: 'a',
        sources: ['ad', 7, 'nope'],
        sort: 'owner_name',
        dir: 'up',
        hiddenColumns: ['email', 'phone', 3],
        personalOnly: 'yes',
        futureKey: true,
      })
    ).toEqual({
      ...EMPTY_VIEW_FILTERS,
      sources: ['ad'],
      hiddenColumns: ['email'],
    });
  });
  it('keeps the owner, assignee and last-activity sorts (migration 257)', () => {
    for (const sort of ['owner', 'assignee', 'activity'] as const) {
      const v = toViewFilters({
        search: '',
        chatTagIds: [],
        sources: [],
        sort: { sort, dir: 'desc' },
        hiddenColumns: ['lastActivity'],
      });
      const back = fromViewFilters(JSON.parse(JSON.stringify(v)));
      expect(back.sort).toBe(sort);
      expect(back.dir).toBe('desc');
      expect(back.hiddenColumns).toEqual(['lastActivity']);
      expect(sameViewFilters(v, back)).toBe(true);
    }
    // A bad direction takes the key's own default.
    expect(fromViewFilters({ sort: 'activity', dir: 'up' }).dir).toBe('desc');
  });
  it('bounds the search and drops non-string tag ids', () => {
    const v = fromViewFilters({
      search: 'a'.repeat(500),
      chatTagIds: ['ok', 1, '', 'ok'],
    });
    expect(v.search).toHaveLength(200);
    expect(v.chatTagIds).toEqual(['ok']);
  });
});

describe('sameViewFilters', () => {
  it('ignores tag order and personalOnly', () => {
    const a = { ...EMPTY_VIEW_FILTERS, chatTagIds: ['a', 'b'] };
    const b = {
      ...EMPTY_VIEW_FILTERS,
      chatTagIds: ['b', 'a'],
      personalOnly: true,
    };
    expect(sameViewFilters(a, b)).toBe(true);
    expect(sameViewFilters(a, { ...a, sort: 'name' })).toBe(false);
  });
});
