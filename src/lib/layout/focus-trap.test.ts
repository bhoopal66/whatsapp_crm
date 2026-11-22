import { describe, expect, it } from 'vitest';
import { MOBILE_TAB_HREFS, trapTabTarget } from './focus-trap';

describe('trapTabTarget', () => {
  it('does nothing for an empty drawer', () => {
    expect(trapTabTarget(0, -1, false)).toBeNull();
  });
  it('pulls focus in from outside', () => {
    expect(trapTabTarget(5, -1, false)).toBe(0);
    expect(trapTabTarget(5, -1, true)).toBe(4);
  });
  it('wraps at both ends', () => {
    expect(trapTabTarget(5, 4, false)).toBe(0);
    expect(trapTabTarget(5, 0, true)).toBe(4);
  });
  it('leaves the middle to the browser', () => {
    expect(trapTabTarget(5, 2, false)).toBeNull();
    expect(trapTabTarget(5, 2, true)).toBeNull();
  });
  it('names the four tabs before More', () => {
    expect(MOBILE_TAB_HREFS).toEqual([
      '/inbox',
      '/worklist',
      '/contacts',
      '/chat',
    ]);
  });
});
