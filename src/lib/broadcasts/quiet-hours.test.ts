import { describe, it, expect } from 'vitest';
import {
  parseQuietHours,
  isInQuietHours,
  nextAllowedSendTime,
  localMinutes,
} from './quiet-hours';

// Dubai is UTC+4 with no DST, which keeps the arithmetic legible.
const DUBAI = { start: '21:00', end: '08:00', tz: 'Asia/Dubai' };

describe('parseQuietHours', () => {
  it('accepts a well-formed window', () => {
    expect(parseQuietHours(DUBAI)).toEqual(DUBAI);
  });

  it('rejects malformed times, unknown zones, and empty windows', () => {
    expect(parseQuietHours(null)).toBeNull();
    expect(parseQuietHours({ ...DUBAI, start: '9:00' })).toBeNull();
    expect(parseQuietHours({ ...DUBAI, end: '24:00' })).toBeNull();
    expect(parseQuietHours({ ...DUBAI, tz: 'Mars/Olympus' })).toBeNull();
    expect(parseQuietHours({ ...DUBAI, end: '21:00' })).toBeNull();
  });
});

describe('localMinutes', () => {
  it('reads the wall clock in the zone', () => {
    // 20:30 UTC = 00:30 Dubai
    expect(localMinutes(new Date('2026-09-16T20:30:00Z'), 'Asia/Dubai')).toBe(
      30
    );
  });
});

describe('isInQuietHours', () => {
  it('handles a window spanning midnight', () => {
    // 23:00 Dubai = 19:00Z → quiet
    expect(isInQuietHours(new Date('2026-09-16T19:00:00Z'), DUBAI)).toBe(true);
    // 03:00 Dubai = 23:00Z (previous day) → quiet
    expect(isInQuietHours(new Date('2026-09-15T23:00:00Z'), DUBAI)).toBe(true);
    // 08:00 Dubai = 04:00Z → end is exclusive → not quiet
    expect(isInQuietHours(new Date('2026-09-16T04:00:00Z'), DUBAI)).toBe(false);
    // 12:00 Dubai → not quiet
    expect(isInQuietHours(new Date('2026-09-16T08:00:00Z'), DUBAI)).toBe(false);
  });

  it('handles a same-day window', () => {
    const lunch = { start: '12:00', end: '14:00', tz: 'UTC' };
    expect(isInQuietHours(new Date('2026-09-16T12:00:00Z'), lunch)).toBe(true);
    expect(isInQuietHours(new Date('2026-09-16T13:59:00Z'), lunch)).toBe(true);
    expect(isInQuietHours(new Date('2026-09-16T14:00:00Z'), lunch)).toBe(false);
    expect(isInQuietHours(new Date('2026-09-16T11:59:00Z'), lunch)).toBe(false);
  });
});

describe('nextAllowedSendTime', () => {
  it('returns now when outside the window', () => {
    const now = new Date('2026-09-16T08:00:00Z');
    expect(nextAllowedSendTime(now, DUBAI)).toBe(now);
  });

  it('defers to the end of the window across midnight', () => {
    // 22:15:40 Dubai → next 08:00 Dubai = 04:00Z next day
    const now = new Date('2026-09-16T18:15:40Z');
    expect(nextAllowedSendTime(now, DUBAI).toISOString()).toBe(
      '2026-09-17T04:00:00.000Z'
    );
  });

  it('defers to the end of a same-day window', () => {
    const lunch = { start: '12:00', end: '14:00', tz: 'UTC' };
    expect(
      nextAllowedSendTime(new Date('2026-09-16T12:30:00Z'), lunch).toISOString()
    ).toBe('2026-09-16T14:00:00.000Z');
  });

  it('re-aligns to the wall-clock end across a DST change', () => {
    // Europe/London springs forward 2026-03-29 at 01:00Z (01:00→02:00
    // local). 23:30 local on the 28th, window 21:00–08:00: the naive
    // +8h30 lands at 08:00Z which is 09:00 BST — must correct to 07:00Z.
    const london = { start: '21:00', end: '08:00', tz: 'Europe/London' };
    const now = new Date('2026-03-28T23:30:00Z');
    const next = nextAllowedSendTime(now, london);
    expect(localMinutes(next, 'Europe/London')).toBe(8 * 60);
    expect(next.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });
});
