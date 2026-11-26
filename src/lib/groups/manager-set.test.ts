import { describe, expect, it } from 'vitest';

import { managerSaveBody, managersEdited, wantedManagers } from './manager-set';

const loaded = [
  { userId: 'c', isCreator: true },
  { userId: 'a', isCreator: false },
];

describe('the managers editor', () => {
  it('sends the set it loaded beside the selection', () => {
    expect(managerSaveBody(loaded, ['b'])).toEqual({
      userIds: ['b'],
      base: ['a'],
    });
  });

  it('is edited only when the selection differs', () => {
    expect(managersEdited(loaded, ['a'])).toBe(false);
    expect(managersEdited(loaded, [])).toBe(true);
    expect(managersEdited(loaded, ['b'])).toBe(true);
    expect(managersEdited([], [])).toBe(false);
  });

  it('applies the difference, or the whole set without a base', () => {
    const before = ['c', 'a', 'new'];
    expect(wantedManagers({ before, userIds: ['b'], base: ['a'] })).toEqual([
      'c',
      'new',
      'b',
    ]);
    expect(wantedManagers({ before, userIds: ['b'] })).toEqual(['b']);
  });
});
