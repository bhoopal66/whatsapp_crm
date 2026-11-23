import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RESPONSE_HOURS,
  DEFAULT_TARGET_MINUTES,
  DEFAULT_TIMEZONE,
  businessMinutesBetween,
  endFromInput,
  endToInput,
  nextInterval,
  parseResponseSettings,
  responseSettingsDiff,
  splitMinutes,
  validateHours,
  waitLevel,
  type BusinessHours,
} from './hours';

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/237_response_targets.sql'),
  'utf8'
);

const at = (iso: string) => Date.parse(iso);

describe('defaults', () => {
  it('match 237 (hours, zone, target)', () => {
    const m = MIGRATION.match(
      /FUNCTION public\.response_default_hours\(\)[\s\S]*?SELECT '([^']+)'::jsonb/
    );
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual(DEFAULT_RESPONSE_HOURS);
    expect(MIGRATION).toContain(
      `timezone       text NOT NULL DEFAULT '${DEFAULT_TIMEZONE}'`
    );
    expect(MIGRATION).toContain(
      `target_minutes integer NOT NULL DEFAULT ${DEFAULT_TARGET_MINUTES}`
    );
  });
});

describe("businessMinutesBetween (the verify file's vectors)", () => {
  it('Friday evening to Saturday morning', () => {
    expect(
      businessMinutesBetween(at('2026-11-20T13:30Z'), at('2026-11-21T05:30Z'))
    ).toBe(60);
  });

  it('skips Sunday', () => {
    expect(
      businessMinutesBetween(at('2026-11-21T13:00Z'), at('2026-11-23T06:00Z'))
    ).toBe(120);
  });

  it('counts nothing at night', () => {
    expect(
      businessMinutesBetween(at('2026-11-19T16:00Z'), at('2026-11-20T04:00Z'))
    ).toBe(0);
  });

  it('a whole working day is 540', () => {
    expect(
      businessMinutesBetween(at('2026-11-19T00:00Z'), at('2026-11-19T20:00Z'))
    ).toBe(540);
  });

  it('a reversed or empty range is 0', () => {
    expect(
      businessMinutesBetween(at('2026-11-20T06:00Z'), at('2026-11-20T05:00Z'))
    ).toBe(0);
    expect(businessMinutesBetween(NaN, at('2026-11-20T05:00Z'))).toBe(0);
  });

  it('split hours in another zone', () => {
    expect(
      businessMinutesBetween(
        at('2026-11-23T11:00Z'),
        at('2026-11-23T14:00Z'),
        {
          mon: [
            ['09:00', '12:00'],
            ['13:00', '17:00'],
          ],
        },
        'UTC'
      )
    ).toBe(120);
  });

  it('a 24:00 end runs to midnight', () => {
    expect(
      businessMinutesBetween(
        at('2026-11-23T00:00Z'),
        at('2026-11-24T00:00Z'),
        { mon: [['00:00', '24:00']] },
        'UTC'
      )
    ).toBe(1440);
  });

  it('follows the wall clock across a DST change', () => {
    // Europe/London leaves summer time on Sunday 2026-10-25; 09:00-10:00
    // local is 08:00Z before and 09:00Z after.
    const h: BusinessHours = {
      sat: [['09:00', '10:00']],
      mon: [['09:00', '10:00']],
    };
    expect(
      businessMinutesBetween(
        at('2026-10-24T08:00Z'),
        at('2026-10-24T09:00Z'),
        h,
        'Europe/London'
      )
    ).toBe(60);
    expect(
      businessMinutesBetween(
        at('2026-10-26T09:00Z'),
        at('2026-10-26T10:00Z'),
        h,
        'Europe/London'
      )
    ).toBe(60);
  });
});

describe('validateHours (response_hours_valid)', () => {
  it('accepts the defaults, closed days and 24:00', () => {
    expect(validateHours(DEFAULT_RESPONSE_HOURS)).toBe(true);
    expect(validateHours({})).toBe(true);
    expect(validateHours({ sun: [['00:00', '24:00']] })).toBe(true);
  });

  it.each([
    ['not an object', []],
    ['an unknown day', { monday: [] }],
    ['backwards', { mon: [['18:00', '09:00']] }],
    [
      'overlapping',
      {
        mon: [
          ['09:00', '12:00'],
          ['11:00', '14:00'],
        ],
      },
    ],
    ['a bad time', { mon: [['9:00', '18:00']] }],
    ['24:00 as a start', { mon: [['24:00', '24:00']] }],
    [
      'too many',
      {
        mon: [
          ['01:00', '02:00'],
          ['03:00', '04:00'],
          ['05:00', '06:00'],
          ['07:00', '08:00'],
          ['09:00', '10:00'],
        ],
      },
    ],
  ])('refuses %s', (_name, hours) => {
    expect(validateHours(hours)).toBe(false);
  });
});

describe('parseResponseSettings', () => {
  it('falls back to the defaults', () => {
    const s = parseResponseSettings(null);
    expect(s).toEqual({
      enabled: false,
      timezone: 'Asia/Dubai',
      hours: DEFAULT_RESPONSE_HOURS,
      targetMinutes: 15,
    });
  });

  it('reads a row and fills closed days', () => {
    const s = parseResponseSettings({
      enabled: true,
      timezone: 'UTC',
      hours: { mon: [['08:00', '12:00']] },
      target_minutes: 30,
    });
    expect(s.enabled).toBe(true);
    expect(s.timezone).toBe('UTC');
    expect(s.targetMinutes).toBe(30);
    expect(s.hours.mon).toEqual([['08:00', '12:00']]);
    expect(s.hours.tue).toEqual([]);
  });

  it('ignores bad values', () => {
    const s = parseResponseSettings({ hours: 'x', target_minutes: 0 });
    expect(s.hours).toEqual(DEFAULT_RESPONSE_HOURS);
    expect(s.targetMinutes).toBe(15);
  });
});

describe('display helpers', () => {
  it('splitMinutes', () => {
    expect(splitMinutes(130)).toEqual({ hours: 2, minutes: 10 });
    expect(splitMinutes(-5)).toEqual({ hours: 0, minutes: 0 });
  });

  it('waitLevel', () => {
    expect(waitLevel(14, 15)).toBe('ok');
    expect(waitLevel(15, 15)).toBe('target');
    expect(waitLevel(30, 15)).toBe('escalated');
  });
});

describe('form helpers', () => {
  it('shows a midnight end as 00:00 and reads it back', () => {
    expect(endToInput('24:00')).toBe('00:00');
    expect(endToInput('18:00')).toBe('18:00');
    expect(endFromInput('00:00')).toBe('24:00');
    expect(endFromInput('17:30')).toBe('17:30');
  });

  it('nextInterval follows the last one, up to four', () => {
    expect(nextInterval([])).toEqual(['09:00', '18:00']);
    expect(nextInterval([['09:00', '12:00']])).toEqual(['12:00', '13:00']);
    expect(nextInterval([['09:00', '23:30']])).toBeNull();
    expect(nextInterval([['09:00', '24:00']])).toBeNull();
    expect(
      nextInterval([
        ['01:00', '02:00'],
        ['03:00', '04:00'],
        ['05:00', '06:00'],
        ['07:00', '08:00'],
      ])
    ).toBeNull();
  });
});

describe('responseSettingsDiff', () => {
  const saved = parseResponseSettings({
    enabled: true,
    timezone: 'Asia/Dubai',
    hours: { mon: [['09:00', '18:00']] },
    target_minutes: 20,
  });

  it('is empty when nothing changed', () => {
    expect(responseSettingsDiff(saved, structuredClone(saved))).toEqual({});
  });

  it('holds only the fields that changed', () => {
    expect(responseSettingsDiff(saved, { ...saved, targetMinutes: 5 })).toEqual(
      { targetMinutes: 5 }
    );
    expect(responseSettingsDiff(saved, { ...saved, enabled: false })).toEqual({
      enabled: false,
    });
    expect(responseSettingsDiff(saved, { ...saved, timezone: 'UTC' })).toEqual({
      timezone: 'UTC',
    });
  });

  it.each([
    ['a moved end', { mon: [['09:00', '17:00']] }],
    ['a closed day', { mon: [] }],
    ['an opened day', { sun: [['09:00', '12:00']] }],
    [
      'a split day',
      {
        mon: [
          ['09:00', '12:00'],
          ['12:00', '18:00'],
        ],
      },
    ],
  ])('sends the hours for %s', (_n, day) => {
    const hours = { ...saved.hours, ...day } as typeof saved.hours;
    expect(responseSettingsDiff(saved, { ...saved, hours })).toEqual({ hours });
  });
});
