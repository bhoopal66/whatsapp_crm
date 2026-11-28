import { describe, expect, it } from 'vitest';

import { DEFAULT_SCHEDULE, buildSchedule } from './schedule';
import {
  cronMatches,
  dueSlot,
  isKnownTimeZone,
  localMinuteOf,
  parseCron,
} from './cron';

const DUBAI = 'Asia/Dubai';

describe('parseCron', () => {
  it('reads every preset the builder writes', () => {
    expect(parseCron(DEFAULT_SCHEDULE)).not.toBeNull();
    expect(parseCron(buildSchedule('weekdays', '08:30'))).not.toBeNull();
    expect(parseCron(buildSchedule('hourly', '09:00'))).not.toBeNull();
  });

  it('reads a legacy HH:mm as every day at that time', () => {
    const s = parseCron('14:05')!;
    expect(s.hour.values).toEqual(new Set([14]));
    expect(s.minute.values).toEqual(new Set([5]));
    expect(s.dow.any && s.dom.any).toBe(true);
  });

  it('reads lists, ranges and steps; 7 is Sunday', () => {
    const s = parseCron('*/15 9-17/4 1,15 * 7')!;
    expect([...s.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...s.hour.values]).toEqual([9, 13, 17]);
    expect(s.dow.values.has(0)).toBe(true);
  });

  it('refuses what it cannot read', () => {
    for (const bad of [
      '',
      'every day',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '* * * *',
      '* * * * * *',
      null,
      undefined,
    ]) {
      expect(parseCron(bad as string)).toBeNull();
    }
  });
});

describe('cronMatches', () => {
  // 2026-11-23 is a Monday. 05:00Z is 09:00 in Dubai.
  const mondayNine = localMinuteOf(new Date('2026-11-23T05:00:00Z'), DUBAI);
  const sundayNine = localMinuteOf(new Date('2026-11-22T05:00:00Z'), DUBAI);

  it('reads the wall clock in the zone', () => {
    expect(mondayNine).toEqual({
      minute: 0,
      hour: 9,
      day: 23,
      month: 11,
      weekday: 1,
    });
  });

  it('runs weekdays only on weekdays', () => {
    const s = parseCron('0 9 * * 1-5')!;
    expect(cronMatches(s, mondayNine)).toBe(true);
    expect(cronMatches(s, sundayNine)).toBe(false);
  });

  it('matches either day field when both are restricted', () => {
    const s = parseCron('0 9 1 * 1')!;
    expect(cronMatches(s, mondayNine)).toBe(true); // Monday, not the 1st
    expect(cronMatches(s, { ...sundayNine, day: 1 })).toBe(true);
    expect(cronMatches(s, sundayNine)).toBe(false);
  });
});

describe('dueSlot', () => {
  const daily = parseCron('0 9 * * *')!;
  const nineDubai = new Date('2026-11-23T05:00:00Z');

  it('finds the slot at the minute and within the look-back', () => {
    expect(dueSlot(daily, DUBAI, nineDubai, 15)).toEqual(nineDubai);
    expect(dueSlot(daily, DUBAI, new Date('2026-11-23T05:12:40Z'), 15)).toEqual(
      nineDubai
    );
  });

  it('gives nothing once the look-back has passed or before the slot', () => {
    expect(
      dueSlot(daily, DUBAI, new Date('2026-11-23T05:15:00Z'), 15)
    ).toBeNull();
    expect(
      dueSlot(daily, DUBAI, new Date('2026-11-23T04:59:00Z'), 15)
    ).toBeNull();
  });

  it('never runs a slot from before the automation was saved', () => {
    expect(
      dueSlot(
        daily,
        DUBAI,
        new Date('2026-11-23T05:05:00Z'),
        15,
        new Date('2026-11-23T05:03:00Z')
      )
    ).toBeNull();
    expect(
      dueSlot(
        daily,
        DUBAI,
        new Date('2026-11-23T05:05:00Z'),
        15,
        new Date('2026-11-23T04:00:00Z')
      )
    ).toEqual(nineDubai);
  });

  it('uses the zone, not the server clock', () => {
    // 09:00 UTC is 13:00 in Dubai: a Dubai 09:00 schedule does not run.
    expect(
      dueSlot(daily, DUBAI, new Date('2026-11-23T09:00:00Z'), 1)
    ).toBeNull();
    expect(
      dueSlot(daily, 'UTC', new Date('2026-11-23T09:00:00Z'), 1)
    ).not.toBeNull();
  });
});

describe('isKnownTimeZone', () => {
  it('knows real zones only', () => {
    expect(isKnownTimeZone(DUBAI)).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
  });
});
