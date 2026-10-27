import { describe, expect, it } from 'vitest';

import { notificationBadgeLabel } from './badge';

describe('notificationBadgeLabel', () => {
  it.each([0, -1, Number.NaN])('hides the badge for %s', (n) => {
    expect(notificationBadgeLabel(n)).toBeNull();
  });

  it.each([
    [1, '1'],
    [9, '9'],
    [10, '10'],
    [99, '99'],
    [100, '99+'],
    [5000, '99+'],
  ])('shows %s as %s', (n, label) => {
    expect(notificationBadgeLabel(n)).toBe(label);
  });
});
