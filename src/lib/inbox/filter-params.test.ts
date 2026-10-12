import { describe, expect, it } from 'vitest';

import { parseInboxFilterParams } from './filter-params';

const U = '11111111-2222-4333-8444-555555555555';
const p = (q: string) => new URLSearchParams(q);

describe('parseInboxFilterParams', () => {
  it('reads assignee and tag', () => {
    expect(parseInboxFilterParams(p('assignee=unassigned'), U)).toEqual({
      assignee: 'unassigned',
      chatTagIds: [],
    });
    expect(parseInboxFilterParams(p(`assignee=me&tag=${U}`), 'me-id')).toEqual({
      assignee: 'me-id',
      chatTagIds: [U],
    });
    expect(
      parseInboxFilterParams(p(`assignee=${U.toUpperCase()}`), null).assignee
    ).toBe(U);
  });
  it('ignores anything else', () => {
    expect(parseInboxFilterParams(p('assignee=me'), null).assignee).toBeNull();
    expect(parseInboxFilterParams(p('assignee=x&tag=nope'), U)).toEqual({
      assignee: null,
      chatTagIds: [],
    });
  });
});
