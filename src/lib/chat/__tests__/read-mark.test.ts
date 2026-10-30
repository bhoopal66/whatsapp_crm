import { describe, expect, it } from 'vitest';

import { shouldMarkRead, type ReadMark } from '../read-mark';

const base = {
  channelId: 'c1',
  loading: false,
  member: true,
  visible: true,
  newestId: 'm1',
};

/**
 * Runs the channel view's mark-read decision over a sequence of renders,
 * recording each mark as the view does, and counts the marks.
 */
function marks(renders: (typeof base)[]): number {
  let last: ReadMark | null = null;
  let n = 0;
  for (const r of renders) {
    if (!shouldMarkRead({ ...r, last })) continue;
    n++;
    last = { channelId: r.channelId, newestId: r.newestId ?? null };
  }
  return n;
}

describe('shouldMarkRead', () => {
  it('marks an idle channel once, however often the list reloads', () => {
    // Each mark's member-row echo reloads the list and re-renders the view
    // with nothing new: the tab coming back and further reloads included.
    expect(marks(Array.from({ length: 20 }, () => ({ ...base })))).toBe(1);
  });

  it('marks again for a newer message, and for another channel', () => {
    expect(
      marks([
        base,
        base,
        { ...base, newestId: 'm2' },
        { ...base, newestId: 'm2' },
        { ...base, channelId: 'c2', newestId: 'x1' },
      ])
    ).toBe(3);
  });

  it('marks an empty channel once', () => {
    const empty = { ...base, newestId: undefined as unknown as string };
    expect(marks([empty, empty, empty])).toBe(1);
  });

  it('waits for the first page, a member row and a visible tab', () => {
    const last = null;
    expect(shouldMarkRead({ ...base, loading: true, last })).toBe(false);
    expect(shouldMarkRead({ ...base, member: false, last })).toBe(false);
    expect(shouldMarkRead({ ...base, visible: false, last })).toBe(false);
  });

  it('marks what arrived while hidden once the tab is visible again', () => {
    expect(
      marks([
        base,
        { ...base, newestId: 'm2', visible: false },
        { ...base, newestId: 'm2' },
        { ...base, newestId: 'm2' },
      ])
    ).toBe(2);
  });
});
