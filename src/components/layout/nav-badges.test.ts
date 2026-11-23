import { describe, expect, it } from 'vitest';

import { sumGroupBadge, teamInboxBadgeCount } from './nav-badges';

describe('sumGroupBadge', () => {
  const counts: Record<string, number> = { '/inbox': 3, '/groups': 4 };
  it('adds the counts of the visible rows', () => {
    expect(sumGroupBadge(['/inbox', '/groups', '/x'], (h) => counts[h])).toBe(
      7
    );
  });
  it('is 0 when nothing is waiting', () => {
    expect(sumGroupBadge(['/x'], () => null)).toBe(0);
    expect(sumGroupBadge([], () => 5)).toBe(0);
  });
  it('ignores negative and non-finite figures', () => {
    const n: Record<string, number> = { a: -2, b: NaN, c: 1 };
    expect(sumGroupBadge(['a', 'b', 'c'], (h) => n[h])).toBe(1);
  });
});

describe('teamInboxBadgeCount', () => {
  it('shows the team unread only with the team view', () => {
    expect(teamInboxBadgeCount(true, 5, 2)).toBe(5);
    expect(teamInboxBadgeCount(false, 5, 2)).toBe(0);
  });
  it('is hidden at 0', () => {
    expect(teamInboxBadgeCount(true, 0, 0)).toBe(0);
  });
  it('does not repeat the personal figure', () => {
    expect(teamInboxBadgeCount(true, 4, 4)).toBe(0);
    expect(teamInboxBadgeCount(true, 5, 0)).toBe(5);
  });
});
