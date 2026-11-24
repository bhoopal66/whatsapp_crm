import { describe, expect, it } from 'vitest';

import { markLanded, shouldMarkRead } from '../read-mark';

const T10_00 = '2026-11-24T10:00:00.000000+00:00';
const T10_05 = '2026-11-24T10:05:00.000000+00:00';

const base = {
  ready: true,
  member: true,
  visible: true,
  at: T10_00 as string | null,
  held: null as string | null,
  sent: null as string | null,
};

/** Runs the decision over a sequence of renders and counts the marks. */
function marks(renders: (typeof base)[]): number {
  let sent: string | null = null;
  let n = 0;
  for (const r of renders) {
    if (!shouldMarkRead({ ...r, sent })) continue;
    n++;
    sent = r.at;
  }
  return n;
}

describe('shouldMarkRead', () => {
  it('marks an idle channel once, however often the list reloads', () => {
    // Each mark's member-row echo reloads the list and re-renders the view
    // with nothing new: the tab coming back and further reloads included.
    expect(marks(Array.from({ length: 20 }, () => ({ ...base })))).toBe(1);
    expect(
      marks(Array.from({ length: 20 }, () => ({ ...base, held: T10_00 })))
    ).toBe(0);
  });

  it('marks again for a newer message', () => {
    expect(marks([base, base, { ...base, at: T10_05 }])).toBe(2);
  });

  it('has nothing to mark in an empty channel', () => {
    expect(shouldMarkRead({ ...base, at: null })).toBe(false);
  });

  it('waits for what is shown, a member row and a visible tab', () => {
    expect(shouldMarkRead({ ...base, ready: false })).toBe(false);
    expect(shouldMarkRead({ ...base, member: false })).toBe(false);
    expect(shouldMarkRead({ ...base, visible: false })).toBe(false);
  });

  it('marks what arrived while hidden once the tab is visible again', () => {
    expect(
      marks([
        base,
        { ...base, at: T10_05, visible: false },
        { ...base, at: T10_05 },
        { ...base, at: T10_05 },
      ])
    ).toBe(2);
  });

  it('never moves the mark back, held or only just sent', () => {
    expect(shouldMarkRead({ ...base, held: T10_05 })).toBe(false);
    expect(shouldMarkRead({ ...base, sent: T10_05 })).toBe(false);
    expect(shouldMarkRead({ ...base, held: T10_05, sent: T10_00 })).toBe(false);
  });

  it('tells microseconds apart, in either form of a timestamp', () => {
    const held = '2026-11-24 10:00:00.000001+00';
    const at = '2026-11-24T10:00:00.000002+00:00';
    expect(shouldMarkRead({ ...base, at, held })).toBe(true);
    expect(shouldMarkRead({ ...base, at: held, held: at })).toBe(false);
  });
});

describe('markLanded', () => {
  it('is the member row at or past what was sent', () => {
    expect(markLanded(null, T10_00)).toBe(false);
    expect(markLanded(T10_00, T10_05)).toBe(false);
    expect(markLanded('2026-11-24 10:00:00+00', T10_00)).toBe(true);
    expect(markLanded(T10_05, T10_00)).toBe(true);
  });
});
