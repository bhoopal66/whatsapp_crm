import { describe, expect, it } from 'vitest';
import { pruneSelection } from './selection';

describe('pruneSelection', () => {
  it('drops a ticked contact the refreshed list no longer shows', () => {
    // Ticked X under search "ali", renamed X to "Omar": the re-read of
    // the same view no longer has X, so the bulk bar must not act on it.
    const next = pruneSelection(new Set(['x', 'y']), ['y', 'z']);
    expect([...next]).toEqual(['y']);
  });

  it('empties the selection when none of it is shown', () => {
    expect(pruneSelection(new Set(['x']), []).size).toBe(0);
  });

  it('returns the same set when every ticked row is still shown', () => {
    const selected = new Set(['x', 'y']);
    expect(pruneSelection(selected, ['x', 'y', 'z'])).toBe(selected);
    const none = new Set<string>();
    expect(pruneSelection(none, ['x'])).toBe(none);
  });
});
