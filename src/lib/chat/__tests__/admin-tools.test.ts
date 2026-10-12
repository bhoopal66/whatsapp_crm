import { describe, expect, it } from 'vitest';

import {
  chunked,
  confirmationMatches,
  privateChannelsNotIn,
  reasonOk,
} from '../admin-tools';

describe('reasonOk', () => {
  it('needs 5 characters after trimming', () => {
    expect(reasonOk('  abcd ')).toBe(false);
    expect(reasonOk('abcde')).toBe(true);
    expect(reasonOk('تحقيق')).toBe(true);
  });
});

describe('confirmationMatches', () => {
  it('ignores case and outer spaces, never matches an empty word', () => {
    expect(confirmationMatches(' erase ', 'ERASE')).toBe(true);
    expect(confirmationMatches('eras', 'ERASE')).toBe(false);
    expect(confirmationMatches('', '')).toBe(false);
  });
});

describe('privateChannelsNotIn', () => {
  const rows = [
    { id: 'p2', kind: 'private', name: 'zeta', members: [{ user_id: 'U1' }] },
    { id: 'p1', kind: 'private', name: 'alpha', members: [], archived_at: 'x' },
    { id: 'pm', kind: 'private', name: 'mine', members: [{ user_id: 'me' }] },
    {
      id: 'd1',
      kind: 'dm',
      name: null,
      members: [{ user_id: 'u1' }, { user_id: 'u2' }],
    },
    { id: 'r1', kind: 'deal_room', name: 'deal', members: null },
    { id: 't1', kind: 'team', name: 'general', members: [] },
  ];

  it('keeps private kinds the viewer is not in, by kind then name', () => {
    expect(
      privateChannelsNotIn(rows, 'ME').map((c) => [
        c.id,
        c.archived,
        c.memberIds,
      ])
    ).toEqual([
      ['p1', true, []],
      ['p2', false, ['U1']],
      ['r1', false, []],
      ['d1', false, ['u1', 'u2']],
    ]);
  });
});

describe('chunked', () => {
  it('slices a list', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 2)).toEqual([]);
  });
});
