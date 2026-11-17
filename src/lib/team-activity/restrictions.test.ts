import { describe, expect, it } from 'vitest';

import { BOOLEAN_LIMITS, TEAM_ACTIVITY_DEFAULTS } from './limits';
import {
  RESTRICTION_RULES,
  limitValueValid,
  ruleSwitchesDisabled,
} from './restrictions';

describe('restrictions', () => {
  it('lists every enforce* switch exactly once', () => {
    const enforce = BOOLEAN_LIMITS.filter((k) => k.startsWith('enforce'));
    expect([...RESTRICTION_RULES].sort()).toEqual([...enforce].sort());
  });

  it('disables the rule switches only while the master is off', () => {
    expect(ruleSwitchesDisabled({ blockOverLimit: false })).toBe(true);
    expect(ruleSwitchesDisabled({ blockOverLimit: true })).toBe(false);
  });

  it('validates the new number fields against their bounds', () => {
    expect(limitValueValid('sameOpenerMax', 3)).toBe(true);
    expect(limitValueValid('sameOpenerMax', 0)).toBe(false);
    expect(limitValueValid('sameOpenerMax', 2.5)).toBe(false);
    expect(limitValueValid('replyRateThrottlePct', 9)).toBe(false);
    expect(limitValueValid('replyRateThrottlePct', 100)).toBe(true);
    expect(
      limitValueValid('jevBlockMinP', TEAM_ACTIVITY_DEFAULTS.jevBlockMinP)
    ).toBe(true);
    expect(limitValueValid('jevBlockMinP', 0.499)).toBe(false);
    expect(limitValueValid('jevBlockMinP', 0.855)).toBe(false);
    expect(limitValueValid('jevBlockMinP', 1)).toBe(false);
    expect(limitValueValid('jevBlockMinP', Number.NaN)).toBe(false);
  });
});
