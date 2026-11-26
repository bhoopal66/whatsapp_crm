import { describe, expect, it } from 'vitest';

import { decisionSkipped, resendNotice } from './notices';

describe('resendNotice', () => {
  it('is a success only when something was sent and nothing failed', () => {
    expect(resendNotice({ sent: 2, failed: 0 })).toEqual({
      level: 'success',
      sent: 2,
    });
  });

  it('is an error when any invite failed, even if others went', () => {
    expect(resendNotice({ sent: 1, failed: 1 })).toEqual({
      level: 'error',
      sent: 1,
      failed: 1,
    });
  });

  it('is a warning naming who was skipped and why when nothing was sent', () => {
    expect(
      resendNotice({
        sent: 0,
        failed: 0,
        skipped: 4,
        alreadyInvited: 1,
        waiting: 1,
        blocked: ['opted_out', 'a_rule_of_a_later_release', 'opted_out'],
      })
    ).toEqual({
      level: 'warning',
      reasons: ['already', 'waiting', 'opted_out', 'other'],
    });
    expect(resendNotice({ sent: 0, failed: 0 })).toEqual({
      level: 'warning',
      reasons: [],
    });
  });
});

describe('decisionSkipped', () => {
  it('is true when requests were skipped, false otherwise', () => {
    expect(decisionSkipped({ skipped: ['jr-1'] })).toBe(true);
    expect(decisionSkipped({ skipped: [] })).toBe(false);
    expect(decisionSkipped({})).toBe(false);
  });
});
