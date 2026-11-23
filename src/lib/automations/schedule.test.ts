import { describe, expect, it } from 'vitest';

import ar from '../../../messages/ar.json';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import {
  AUTOMATION_TIME_ZONE,
  buildSchedule,
  DEFAULT_SCHEDULE,
  formatTimeRange,
  isInTimeRange,
  parseSchedule,
  parseTimeRange,
  type SchedulePreset,
} from './schedule';

describe('parseSchedule', () => {
  it('reads the presets back', () => {
    expect(parseSchedule('0 9 * * *')).toEqual({
      mode: 'daily',
      time: '09:00',
    });
    expect(parseSchedule('30 17 * * 1-5')).toEqual({
      mode: 'weekdays',
      time: '17:30',
    });
    expect(parseSchedule('0 * * * *')).toEqual({ mode: 'hourly', time: null });
  });

  it('tolerates extra whitespace and leading zeros', () => {
    expect(parseSchedule('  05   09 * *   * ')).toEqual({
      mode: 'daily',
      time: '09:05',
    });
  });

  it('reads a legacy HH:mm value as every day at that time', () => {
    expect(parseSchedule('08:15')).toEqual({ mode: 'daily', time: '08:15' });
    expect(parseSchedule('8:15')).toEqual({ mode: 'daily', time: '08:15' });
  });

  it('keeps anything else as custom', () => {
    for (const v of [
      '',
      '*/15 * * * *',
      '0 9 * * 1',
      '0 9 1 * *',
      '15 * * * *',
      '0 9 * * MON-FRI',
      '60 9 * * *',
      '0 24 * * *',
      '25:00',
      'every day',
    ]) {
      expect(parseSchedule(v)).toEqual({ mode: 'custom', time: null });
    }
    expect(parseSchedule(undefined).mode).toBe('custom');
  });
});

describe('buildSchedule', () => {
  it('writes standard cron', () => {
    expect(buildSchedule('daily', '09:00')).toBe('0 9 * * *');
    expect(buildSchedule('weekdays', '17:30')).toBe('30 17 * * 1-5');
    expect(buildSchedule('hourly')).toBe('0 * * * *');
  });

  it('falls back to 09:00 for a missing or broken time', () => {
    expect(buildSchedule('daily')).toBe(DEFAULT_SCHEDULE);
    expect(buildSchedule('weekdays', 'nope')).toBe('0 9 * * 1-5');
  });

  it('round-trips every preset', () => {
    const cases: [SchedulePreset, string | null][] = [
      ['daily', '00:00'],
      ['daily', '23:59'],
      ['weekdays', '07:45'],
      ['hourly', null],
    ];
    for (const [preset, time] of cases) {
      expect(parseSchedule(buildSchedule(preset, time))).toEqual({
        mode: preset,
        time,
      });
    }
  });
});

describe('time ranges', () => {
  it('parses the engine format, over midnight included', () => {
    expect(parseTimeRange('09:00-18:00')).toEqual({
      from: '09:00',
      to: '18:00',
    });
    expect(parseTimeRange('18:00-9:00')).toEqual({
      from: '18:00',
      to: '09:00',
    });
  });

  it('rejects anything else', () => {
    for (const v of [
      '',
      '09:00',
      '09:00-',
      '9-18',
      '09:00-25:00',
      'a-b',
      '1:00-2:00-3:00',
    ]) {
      expect(parseTimeRange(v)).toBeNull();
    }
    expect(parseTimeRange(null)).toBeNull();
  });

  it('formats back to the stored shape', () => {
    expect(formatTimeRange({ from: '18:00', to: '09:00' })).toBe('18:00-09:00');
    expect(formatTimeRange(parseTimeRange('7:05-8:10')!)).toBe('07:05-08:10');
  });
});

describe('isInTimeRange', () => {
  const at = (iso: string, operand: string, tz?: string) =>
    isInTimeRange(operand, new Date(iso), tz);

  it('reads the Dubai wall clock by default, start in and end out', () => {
    expect(at('2026-01-15T05:00:00Z', '09:00-18:00')).toBe(true);
    expect(at('2026-01-15T04:59:00Z', '09:00-18:00')).toBe(false);
    expect(at('2026-01-15T14:00:00Z', '09:00-18:00')).toBe(false);
  });

  it('wraps an overnight window', () => {
    expect(at('2026-01-15T14:00:00Z', '18:00-09:00')).toBe(true);
    expect(at('2026-01-15T22:00:00Z', '18:00-09:00')).toBe(true);
    expect(at('2026-01-15T05:00:00Z', '18:00-09:00')).toBe(false);
  });

  it('follows daylight saving in a zone that has it', () => {
    const tz = 'Europe/London';
    expect(at('2026-01-15T08:30:00Z', '09:00-18:00', tz)).toBe(false);
    expect(at('2026-07-15T08:30:00Z', '09:00-18:00', tz)).toBe(true);
  });

  it('an empty or unreadable window is never in', () => {
    expect(at('2026-01-15T05:00:00Z', '09:00-09:00')).toBe(false);
    expect(at('2026-01-15T05:00:00Z', '')).toBe(false);
    expect(isInTimeRange(undefined, new Date())).toBe(false);
  });

  it('the builder hint names the zone in every language', () => {
    for (const m of [en, ar, ko]) {
      expect(m.Automations.builder.config.timeRangeHint).toContain(
        AUTOMATION_TIME_ZONE
      );
    }
  });
});
