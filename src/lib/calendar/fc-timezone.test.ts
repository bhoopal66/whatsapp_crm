import { describe, expect, it } from 'vitest';

import {
  IntlNamedTimeZone,
  calendarTimeZone,
  isValidTimeZone,
  offsetForWallArray,
  timestampToWallArray,
  wallArrayToTimestamp,
  wallDateKey,
  zoneOffsetMinutes,
} from './fc-timezone';

const utc = (iso: string) => Date.parse(iso);

describe('zoneOffsetMinutes', () => {
  it('reads a fixed zone', () => {
    expect(zoneOffsetMinutes('Asia/Dubai', utc('2026-01-15T12:00:00Z'))).toBe(
      240
    );
    expect(zoneOffsetMinutes('Asia/Dubai', utc('2026-07-15T12:00:00Z'))).toBe(
      240
    );
    expect(zoneOffsetMinutes('UTC', utc('2026-07-15T12:00:00Z'))).toBe(0);
  });

  it('follows New York across both 2026 transitions', () => {
    expect(
      zoneOffsetMinutes('America/New_York', utc('2026-03-08T06:59:59Z'))
    ).toBe(-300);
    expect(
      zoneOffsetMinutes('America/New_York', utc('2026-03-08T07:00:00Z'))
    ).toBe(-240);
    expect(
      zoneOffsetMinutes('America/New_York', utc('2026-11-01T05:59:59Z'))
    ).toBe(-240);
    expect(
      zoneOffsetMinutes('America/New_York', utc('2026-11-01T06:00:00Z'))
    ).toBe(-300);
  });

  it('follows London and a half-hour zone', () => {
    expect(
      zoneOffsetMinutes('Europe/London', utc('2026-03-29T00:59:00Z'))
    ).toBe(0);
    expect(
      zoneOffsetMinutes('Europe/London', utc('2026-03-29T01:00:00Z'))
    ).toBe(60);
    expect(zoneOffsetMinutes('Asia/Kolkata', utc('2026-03-29T01:00:00Z'))).toBe(
      330
    );
  });
});

describe('timestampToWallArray', () => {
  it('gives the wall clock with a 0-based month and the ms', () => {
    expect(
      timestampToWallArray('Asia/Dubai', utc('2026-12-31T22:30:15.250Z'))
    ).toEqual([2027, 0, 1, 2, 30, 15, 250]);
  });

  it('gives midnight as hour 0, never 24', () => {
    expect(timestampToWallArray('UTC', utc('2026-05-01T00:00:00Z'))[3]).toBe(0);
  });
});

describe('offsetForWallArray', () => {
  const ny = 'America/New_York';

  it('reads ordinary wall times on either side of a transition', () => {
    expect(offsetForWallArray(ny, [2026, 2, 7, 12, 0, 0, 0])).toBe(-300);
    expect(offsetForWallArray(ny, [2026, 2, 9, 12, 0, 0, 0])).toBe(-240);
    expect(offsetForWallArray(ny, [2026, 2, 8, 1, 59, 0, 0])).toBe(-300);
    expect(offsetForWallArray(ny, [2026, 2, 8, 3, 0, 0, 0])).toBe(-240);
  });

  it('reads a skipped wall time with the offset before the jump', () => {
    // 02:30 does not exist on 2026-03-08; it lands at 03:30 EDT.
    expect(offsetForWallArray(ny, [2026, 2, 8, 2, 30, 0, 0])).toBe(-300);
    expect(wallArrayToTimestamp(ny, [2026, 2, 8, 2, 30, 0, 0])).toBe(
      utc('2026-03-08T07:30:00Z')
    );
  });

  it('reads a repeated wall time as its first occurrence', () => {
    // 01:30 happens twice on 2026-11-01; the first is EDT.
    expect(offsetForWallArray(ny, [2026, 10, 1, 1, 30, 0, 0])).toBe(-240);
    expect(
      offsetForWallArray('Europe/London', [2026, 9, 25, 1, 30, 0, 0])
    ).toBe(60);
  });

  it('round-trips through the wall clock in Dubai', () => {
    const ms = utc('2026-10-15T09:45:00Z');
    expect(
      wallArrayToTimestamp('Asia/Dubai', timestampToWallArray('Asia/Dubai', ms))
    ).toBe(ms);
  });
});

describe('IntlNamedTimeZone', () => {
  it('answers FullCalendar with the same figures', () => {
    const tz = new IntlNamedTimeZone('America/New_York');
    expect(tz.offsetForArray([2026, 6, 1, 9, 0, 0, 0])).toBe(-240);
    expect(tz.timestampToArray(utc('2026-07-01T13:00:00Z'))).toEqual([
      2026, 6, 1, 9, 0, 0, 0,
    ]);
  });
});

describe('zone helpers', () => {
  it('validates zones and falls back to local', () => {
    expect(isValidTimeZone('Asia/Dubai')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(calendarTimeZone('Asia/Dubai')).toBe('Asia/Dubai');
    expect(calendarTimeZone('Not/AZone')).toBe('local');
    expect(calendarTimeZone(null)).toBe('local');
  });

  it('keys an instant by the zone date', () => {
    expect(wallDateKey('Asia/Dubai', utc('2026-10-15T21:00:00Z'))).toBe(
      '2026-10-16'
    );
    expect(wallDateKey('UTC', utc('2026-10-15T21:00:00Z'))).toBe('2026-10-15');
  });
});
