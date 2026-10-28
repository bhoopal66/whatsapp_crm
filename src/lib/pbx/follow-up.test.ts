import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FOLLOW_UP_PRESETS,
  followUpDueAt,
  followUpTitleKey,
  parseCustomDueAt,
  toDateTimeLocal,
} from './follow-up';

// Local constructors throughout, so the cases hold in any zone; the
// fixed-offset block pins one to check the stored instant.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi);

describe('followUpDueAt', () => {
  const now = local(2026, 10, 28, 14, 20);

  it('adds one hour', () => {
    expect(followUpDueAt('in1h', now)).toEqual(local(2026, 10, 28, 15, 20));
  });

  it('adds three hours', () => {
    expect(followUpDueAt('in3h', now)).toEqual(local(2026, 10, 28, 17, 20));
  });

  it('is tomorrow at 10:00 local', () => {
    expect(followUpDueAt('tomorrow10', now)).toEqual(local(2026, 10, 29, 10));
  });

  it('is in two days at 10:00 local', () => {
    expect(followUpDueAt('in2days10', now)).toEqual(local(2026, 10, 30, 10));
  });

  it('is tomorrow even just after midnight, never today', () => {
    const early = local(2026, 10, 28, 0, 5);
    expect(followUpDueAt('tomorrow10', early)).toEqual(local(2026, 10, 29, 10));
  });

  it('crosses a month end', () => {
    const jan31 = local(2026, 1, 31, 18);
    expect(followUpDueAt('tomorrow10', jan31)).toEqual(local(2026, 2, 1, 10));
    expect(followUpDueAt('in2days10', jan31)).toEqual(local(2026, 2, 2, 10));
    // 2028 is a leap year: 28 Feb + 2 days is 1 March.
    expect(followUpDueAt('in2days10', local(2028, 2, 28, 9))).toEqual(
      local(2028, 3, 1, 10)
    );
  });

  it('crosses a year end', () => {
    const eve = local(2026, 12, 31, 23, 30);
    expect(followUpDueAt('in1h', eve)).toEqual(local(2027, 1, 1, 0, 30));
    expect(followUpDueAt('tomorrow10', eve)).toEqual(local(2027, 1, 1, 10));
    expect(followUpDueAt('in2days10', eve)).toEqual(local(2027, 1, 2, 10));
  });

  it('is always after now', () => {
    for (const p of FOLLOW_UP_PRESETS)
      expect(followUpDueAt(p, now).getTime()).toBeGreaterThan(now.getTime());
  });

  describe('in a fixed-offset zone (Asia/Dubai, UTC+4, no DST)', () => {
    const saved = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = 'Asia/Dubai';
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });

    it('stores tomorrow 10:00 local as 06:00 UTC', () => {
      const at = new Date('2026-10-28T20:00:00Z'); // 00:00 on the 29th in Dubai
      expect(followUpDueAt('tomorrow10', at).toISOString()).toBe(
        '2026-10-30T06:00:00.000Z'
      );
      expect(followUpDueAt('in2days10', at).toISOString()).toBe(
        '2026-10-31T06:00:00.000Z'
      );
    });
  });
});

describe('parseCustomDueAt', () => {
  const now = local(2026, 10, 28, 14, 20);

  it('reads a datetime-local value as local time', () => {
    expect(parseCustomDueAt('2026-10-28T15:30', now)).toEqual({
      ok: true,
      at: local(2026, 10, 28, 15, 30),
    });
  });

  it('refuses a time that is not in the future', () => {
    expect(parseCustomDueAt('2026-10-28T14:20', now)).toEqual({
      ok: false,
      reason: 'past',
    });
    expect(parseCustomDueAt('2026-10-27T09:00', now)).toEqual({
      ok: false,
      reason: 'past',
    });
  });

  it('refuses a blank, malformed or impossible value', () => {
    for (const v of ['', 'tomorrow', '2026-10-28', '2027-02-31T10:00'])
      expect(parseCustomDueAt(v, now)).toEqual({
        ok: false,
        reason: 'invalid',
      });
  });

  it('round-trips toDateTimeLocal', () => {
    const at = local(2027, 1, 5, 9, 7);
    expect(toDateTimeLocal(at)).toBe('2027-01-05T09:07');
    expect(parseCustomDueAt(toDateTimeLocal(at), now)).toEqual({
      ok: true,
      at,
    });
  });
});

describe('followUpTitleKey', () => {
  it('names the customer when known', () => {
    expect(followUpTitleKey('  Sara  ')).toEqual({
      key: 'titleNamed',
      values: { name: 'Sara' },
    });
  });

  it('is bare without a name', () => {
    expect(followUpTitleKey(null)).toEqual({ key: 'titleBare' });
    expect(followUpTitleKey('   ')).toEqual({ key: 'titleBare' });
  });
});
