import { describe, expect, it } from 'vitest';

import { parseInboxFilterParams } from './filter-params';

const U = '11111111-2222-4333-8444-555555555555';
const p = (q: string) => new URLSearchParams(q);

describe('parseInboxFilterParams', () => {
  it('reads assignee and tag', () => {
    expect(parseInboxFilterParams(p('assignee=unassigned'), U)).toEqual({
      assignee: 'unassigned',
      chatTagIds: [],
      insightFilters: [],
      unread: false,
      pinned: false,
    });
    expect(parseInboxFilterParams(p(`assignee=me&tag=${U}`), 'me-id')).toEqual({
      assignee: 'me-id',
      chatTagIds: [U],
      insightFilters: [],
      unread: false,
      pinned: false,
    });
    expect(
      parseInboxFilterParams(p(`assignee=${U.toUpperCase()}`), null).assignee
    ).toBe(U);
  });
  it('reads the Smart insights filters', () => {
    expect(
      parseInboxFilterParams(p('insight=upset,HOT,nope,hot'), null)
        .insightFilters
    ).toEqual(['hot', 'upset']);
    expect(
      parseInboxFilterParams(p('insight=attention'), null).insightFilters
    ).toEqual(['attention']);
  });
  it('reads the Unread filter', () => {
    expect(parseInboxFilterParams(p('filter=unread'), null).unread).toBe(true);
    expect(parseInboxFilterParams(p('filter=all'), null).unread).toBe(false);
  });
  it('ignores anything else', () => {
    expect(parseInboxFilterParams(p('assignee=me'), null).assignee).toBeNull();
    expect(parseInboxFilterParams(p('assignee=x&tag=nope'), U)).toEqual({
      assignee: null,
      chatTagIds: [],
      insightFilters: [],
      unread: false,
      pinned: false,
    });
  });
  it('reads ?pinned=1 only', () => {
    expect(parseInboxFilterParams(p('pinned=1'), null).pinned).toBe(true);
    expect(parseInboxFilterParams(p('pinned=yes'), null).pinned).toBe(false);
  });
});
