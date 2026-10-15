import { describe, expect, it } from 'vitest';

import { chunk } from './util';

describe('chunk', () => {
  it('cuts a list into slices of at most the given size, in order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(chunk([1], 100)).toEqual([[1]]);
  });

  it('gives no slices for an empty list', () => {
    expect(chunk([], 100)).toEqual([]);
  });

  it('refuses a size below one', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});
