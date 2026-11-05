import { describe, expect, it } from 'vitest';

import { LOCKED_REJOIN_WINDOW_MS, mayEnterLocked } from './attendance';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('mayEnterLocked', () => {
  it('refuses someone who never had a seat', () => {
    expect(mayEnterLocked([], NOW)).toBe(false);
  });

  it('lets an open seat in, however old', () => {
    expect(mayEnterLocked([{ left_at: null }], NOW)).toBe(true);
  });

  it('lets a seat closed within the window in, up to its edge', () => {
    expect(mayEnterLocked([{ left_at: ago(60_000) }], NOW)).toBe(true);
    expect(
      mayEnterLocked([{ left_at: ago(LOCKED_REJOIN_WINDOW_MS) }], NOW)
    ).toBe(true);
  });

  it('refuses a seat closed longer ago, or an unreadable one', () => {
    expect(
      mayEnterLocked([{ left_at: ago(LOCKED_REJOIN_WINDOW_MS + 1) }], NOW)
    ).toBe(false);
    expect(mayEnterLocked([{ left_at: 'nonsense' }], NOW)).toBe(false);
  });

  it('needs only one qualifying seat', () => {
    expect(
      mayEnterLocked(
        [{ left_at: ago(3_600_000) }, { left_at: ago(60_000) }],
        NOW
      )
    ).toBe(true);
  });
});
