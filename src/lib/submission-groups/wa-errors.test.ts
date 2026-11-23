import { describe, expect, it } from 'vitest';

import { unconfirmedCreate, unconfirmedError } from './service';
import { CREATE_STOPPED } from './store';
import {
  closeRemaining,
  closeRemainingText,
  createRefused,
  createRefusedText,
} from './wa-errors';

describe('closeRemaining', () => {
  it('reads back how many are still in the group', () => {
    for (const n of [1, 2, 37])
      expect(closeRemaining(closeRemainingText(n))).toBe(n);
  });

  it('leaves any other close error alone', () => {
    expect(closeRemaining('not admin')).toBeNull();
    expect(closeRemaining(null)).toBeNull();
  });
});

describe('createRefused', () => {
  it('reads each reason back, alone and after an unconfirmed count', () => {
    const prior = { attempts: 2, at: new Date('2026-11-20T10:00:00.000Z') };
    for (const [reason, key] of [
      ['opted_out', 'optedOut'],
      ['do_not_contact', 'doNotContact'],
      [undefined, 'noNumber'],
    ] as const) {
      const text = createRefusedText(reason);
      expect(createRefused(text)).toBe(key);
      // The cron's list leaves out texts that start with this word.
      expect(text.startsWith(CREATE_STOPPED)).toBe(false);
      const counted = unconfirmedError(prior, text);
      expect(createRefused(counted)).toBe(key);
      expect(unconfirmedCreate(counted)).toEqual(prior);
    }
  });

  it('leaves any other create error alone', () => {
    expect(createRefused('not admin')).toBeNull();
    expect(createRefused(null)).toBeNull();
  });
});
