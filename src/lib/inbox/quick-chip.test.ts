import { describe, expect, it } from 'vitest';

import { chipForCount, chipFromView, chipShown, tapChip } from './quick-chip';

describe('the Important / Pinned chip', () => {
  it('tapped on, ends with its last chat and does not come back', () => {
    const on = tapChip('off');
    expect(chipForCount(on, 2, false)).toBe(on);
    const ended = chipForCount(on, 0, false);
    expect(ended).toBe('off');
    expect(chipForCount(ended, 3, false)).toBe('off');
    expect(chipShown(ended, 0)).toBe(false);
  });

  it('is not ended by a list still loading', () => {
    expect(chipForCount('chip', 0, true)).toBe('chip');
  });

  it('from a saved view, stays on with none and can be tapped off', () => {
    const view = chipFromView(true);
    expect(chipForCount(view, 0, false)).toBe(view);
    expect(chipShown(view, 0)).toBe(true);
    expect(tapChip(view)).toBe('off');
    expect(chipFromView(false)).toBe('off');
  });
});
