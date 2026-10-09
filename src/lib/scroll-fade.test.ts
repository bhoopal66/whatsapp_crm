import { describe, expect, it } from 'vitest';

import { scrollFadeEdges, scrollFadeMask } from './scroll-fade';

describe('scrollFadeEdges', () => {
  it('fades nothing when the row fits (desktop)', () => {
    expect(
      scrollFadeEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 600 })
    ).toEqual({ start: false, end: false });
    // A sub-pixel remainder is not overflow.
    expect(
      scrollFadeEdges({ scrollLeft: 0, scrollWidth: 600.5, clientWidth: 600 })
    ).toEqual({ start: false, end: false });
  });

  it('fades the end at the start of an overflowing row', () => {
    expect(
      scrollFadeEdges({ scrollLeft: 0, scrollWidth: 800, clientWidth: 360 })
    ).toEqual({ start: false, end: true });
  });

  it('fades both edges in the middle', () => {
    expect(
      scrollFadeEdges({ scrollLeft: 200, scrollWidth: 800, clientWidth: 360 })
    ).toEqual({ start: true, end: true });
  });

  it('fades the start at the end', () => {
    expect(
      scrollFadeEdges({ scrollLeft: 440, scrollWidth: 800, clientWidth: 360 })
    ).toEqual({ start: true, end: false });
    expect(
      scrollFadeEdges({
        scrollLeft: 439.6,
        scrollWidth: 800,
        clientWidth: 360,
      })
    ).toEqual({ start: true, end: false });
  });
});

describe('scrollFadeMask', () => {
  it('is no mask when nothing is hidden', () => {
    expect(scrollFadeMask({ start: false, end: false })).toBeUndefined();
  });

  it('fades only the hidden edges', () => {
    expect(scrollFadeMask({ start: false, end: true }, 24)).toBe(
      'linear-gradient(to right, #000, #000 calc(100% - 24px), transparent)'
    );
    expect(scrollFadeMask({ start: true, end: false }, 24)).toBe(
      'linear-gradient(to right, transparent, #000 24px, #000)'
    );
    expect(scrollFadeMask({ start: true, end: true }, 24)).toBe(
      'linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 24px), transparent)'
    );
  });
});
