import { describe, expect, it } from 'vitest';

import { hasOverflowEnd } from './overflow-end';

describe('hasOverflowEnd', () => {
  it('is false when the content fits', () => {
    expect(
      hasOverflowEnd({ scrollWidth: 240, clientWidth: 240, scrollLeft: 0 })
    ).toBe(false);
  });

  it('is true while content is hidden past the end', () => {
    expect(
      hasOverflowEnd({ scrollWidth: 420, clientWidth: 240, scrollLeft: 0 })
    ).toBe(true);
    expect(
      hasOverflowEnd({ scrollWidth: 420, clientWidth: 240, scrollLeft: 100 })
    ).toBe(true);
  });

  it('is false once scrolled to the end, allowing sub-pixel rounding', () => {
    expect(
      hasOverflowEnd({ scrollWidth: 420, clientWidth: 240, scrollLeft: 180 })
    ).toBe(false);
    expect(
      hasOverflowEnd({ scrollWidth: 420, clientWidth: 240, scrollLeft: 179.5 })
    ).toBe(false);
  });

  it('reads a negative (RTL) scrollLeft as a distance', () => {
    expect(
      hasOverflowEnd({ scrollWidth: 420, clientWidth: 240, scrollLeft: -180 })
    ).toBe(false);
    expect(
      hasOverflowEnd({ scrollWidth: 420, clientWidth: 240, scrollLeft: -40 })
    ).toBe(true);
  });
});
