import { describe, expect, it } from 'vitest';

import { isRangePreset, rangeFor, zonedDayStart, zoneOffsetMs } from './range';

describe('zoneOffsetMs', () => {
  it('reads fixed and DST zones', () => {
    const t = Date.parse('2026-07-01T12:00:00.250Z');
    expect(zoneOffsetMs(t, 'UTC')).toBe(0);
    expect(zoneOffsetMs(t, 'Asia/Dubai')).toBe(4 * 3600_000);
    expect(zoneOffsetMs(t, 'America/New_York')).toBe(-4 * 3600_000);
    expect(
      zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York')
    ).toBe(-5 * 3600_000);
  });
});

describe('zonedDayStart', () => {
  it('finds local midnight east of UTC', () => {
    // 01:30 in Dubai on 1 Oct is still 30 Sep in UTC.
    const now = new Date('2026-09-30T21:30:00Z');
    expect(zonedDayStart(now, 'Asia/Dubai').toISOString()).toBe(
      '2026-09-30T20:00:00.000Z'
    );
    expect(zonedDayStart(now, 'Asia/Dubai', 1).toISOString()).toBe(
      '2026-09-29T20:00:00.000Z'
    );
    expect(zonedDayStart(now, 'UTC').toISOString()).toBe(
      '2026-09-30T00:00:00.000Z'
    );
  });

  it('finds local midnight west of UTC and across a DST change', () => {
    // US DST ended on 1 Nov 2026 at 02:00 local.
    const now = new Date('2026-11-02T15:00:00Z');
    expect(zonedDayStart(now, 'America/New_York').toISOString()).toBe(
      '2026-11-02T05:00:00.000Z'
    );
    // The day before the change began at EDT midnight (UTC-4).
    expect(zonedDayStart(now, 'America/New_York', 2).toISOString()).toBe(
      '2026-10-31T04:00:00.000Z'
    );
  });

  it('crosses a month boundary', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(zonedDayStart(now, 'UTC', 1).toISOString()).toBe(
      '2026-09-30T00:00:00.000Z'
    );
    expect(zonedDayStart(now, 'UTC', 30).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z'
    );
  });
});

describe('rangeFor', () => {
  const now = new Date('2026-10-01T10:00:00Z');

  it('ends now, starting at local midnight N-1 days back', () => {
    expect(rangeFor('today', now, 'UTC')).toEqual({
      from: new Date('2026-10-01T00:00:00Z'),
      to: now,
    });
    expect(rangeFor('7d', now, 'Asia/Dubai').from.toISOString()).toBe(
      '2026-09-24T20:00:00.000Z'
    );
    expect(rangeFor('30d', now, 'UTC').from.toISOString()).toBe(
      '2026-09-02T00:00:00.000Z'
    );
    expect(rangeFor('90d', now, 'UTC').from.toISOString()).toBe(
      '2026-07-04T00:00:00.000Z'
    );
  });

  it('makes yesterday a whole local day', () => {
    expect(rangeFor('yesterday', now, 'Asia/Dubai')).toEqual({
      from: new Date('2026-09-29T20:00:00Z'),
      to: new Date('2026-09-30T20:00:00Z'),
    });
  });
});

describe('isRangePreset', () => {
  it('accepts the presets only', () => {
    expect(isRangePreset('7d')).toBe(true);
    expect(isRangePreset('8d')).toBe(false);
    expect(isRangePreset(7)).toBe(false);
  });
});
