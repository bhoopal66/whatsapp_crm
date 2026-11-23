import { describe, expect, it } from 'vitest';

import { closeRemaining, closeRemainingText } from './wa-errors';

describe('closeRemaining', () => {
  it('reads back how many are still in the group', () => {
    for (const n of [1, 2, 37])
      expect(closeRemaining(closeRemainingText(n))).toBe(n);
  });

  it('leaves any other close error alone', () => {
    expect(closeRemaining('not admin')).toBeNull();
    expect(closeRemaining(null)).toBeNull();
  });
});
