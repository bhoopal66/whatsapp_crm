import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LIMIT_BOUNDS,
  LIMIT_COLUMNS,
  TEAM_ACTIVITY_DEFAULTS,
  inQuietHours,
  isValidTimeZone,
  limitsFromRow,
  parseLimitsInput,
  rowFromLimits,
} from './limits';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/068_team_activity.sql'),
  'utf8'
);

const NUMERIC = Object.keys(LIMIT_BOUNDS) as Array<keyof typeof LIMIT_BOUNDS>;

describe('defaults and bounds match migration 068', () => {
  it.each(NUMERIC)(
    '%s: column default, CHECK and team_activity_limits()',
    (key) => {
      const column = LIMIT_COLUMNS[key];
      const def = new RegExp(
        `\\n\\s+${column}\\s+\\w+ NOT NULL DEFAULT (\\d+)`
      ).exec(SQL);
      const check = new RegExp(
        `CHECK \\(${column} BETWEEN (\\d+) AND (\\d+)\\)`
      ).exec(SQL);
      const fn = new RegExp(`coalesce\\(s\\.${column}, (\\d+)\\)`).exec(SQL);
      expect(def, `no column default for ${column}`).not.toBeNull();
      expect(check, `no CHECK for ${column}`).not.toBeNull();
      expect(
        fn,
        `no default in team_activity_limits() for ${column}`
      ).not.toBeNull();
      expect(Number(def![1])).toBe(TEAM_ACTIVITY_DEFAULTS[key]);
      expect(Number(fn![1])).toBe(TEAM_ACTIVITY_DEFAULTS[key]);
      expect([Number(check![1]), Number(check![2])]).toEqual(LIMIT_BOUNDS[key]);
    }
  );

  it.each(['notify', 'blockOverLimit'] as const)('%s default', (key) => {
    const column = LIMIT_COLUMNS[key];
    const def = new RegExp(
      `\\n\\s+${column}\\s+boolean NOT NULL DEFAULT (true|false)`
    ).exec(SQL);
    const fn = new RegExp(`coalesce\\(s\\.${column}, (true|false)\\)`).exec(
      SQL
    );
    expect(def?.[1]).toBe(String(TEAM_ACTIVITY_DEFAULTS[key]));
    expect(fn?.[1]).toBe(String(TEAM_ACTIVITY_DEFAULTS[key]));
  });
});

describe('limitsFromRow', () => {
  it('fills every missing or malformed field with the default', () => {
    expect(limitsFromRow(null)).toEqual(TEAM_ACTIVITY_DEFAULTS);
    expect(
      limitsFromRow({
        daily_new_chats_per_user: 'lots',
        notify: 'yes',
        timezone: '  ',
      })
    ).toEqual(TEAM_ACTIVITY_DEFAULTS);
  });

  it('reads a saved row', () => {
    expect(
      limitsFromRow({
        daily_new_chats_per_user: 12,
        daily_new_chats_per_number: 40,
        min_reply_rate: 35,
        max_unanswered_in_row: 2,
        burst_new_chats_10min: 6,
        quiet_hours_start: 21,
        quiet_hours_end: 9,
        timezone: 'Asia/Dubai',
        notify: false,
        block_over_limit: true,
      })
    ).toEqual({
      dailyNewChatsPerUser: 12,
      dailyNewChatsPerNumber: 40,
      minReplyRate: 35,
      maxUnansweredInRow: 2,
      burstNewChats10min: 6,
      quietHoursStart: 21,
      quietHoursEnd: 9,
      timezone: 'Asia/Dubai',
      notify: false,
      blockOverLimit: true,
    });
  });
});

describe('parseLimitsInput', () => {
  const valid = { ...TEAM_ACTIVITY_DEFAULTS, timezone: 'Asia/Dubai' };

  it('accepts a complete, in-bounds body', () => {
    expect(parseLimitsInput(valid)).toEqual({ ok: true, value: valid });
  });

  it('trims the time zone', () => {
    const r = parseLimitsInput({ ...valid, timezone: ' UTC ' });
    expect(r.ok && r.value.timezone).toBe('UTC');
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['a missing limit', { ...valid, minReplyRate: undefined }],
    ['a fraction', { ...valid, dailyNewChatsPerUser: 2.5 }],
    ['a string number', { ...valid, dailyNewChatsPerUser: '20' }],
    ['below the bound', { ...valid, dailyNewChatsPerUser: 0 }],
    ['above the bound', { ...valid, minReplyRate: 101 }],
    ['an hour of 24', { ...valid, quietHoursEnd: 24 }],
    ['a non-boolean switch', { ...valid, blockOverLimit: 'true' }],
    ['an unknown zone', { ...valid, timezone: 'Mars/Olympus' }],
    ['an offset zone', { ...valid, timezone: '+04' }],
    ['no zone', { ...valid, timezone: null }],
  ])('rejects %s', (_label, body) => {
    expect(parseLimitsInput(body).ok).toBe(false);
  });
});

describe('rowFromLimits', () => {
  it('maps every field to its column', () => {
    const row = rowFromLimits('acct', {
      ...TEAM_ACTIVITY_DEFAULTS,
      timezone: 'UTC',
    });
    expect(row).toEqual({
      account_id: 'acct',
      daily_new_chats_per_user: 20,
      daily_new_chats_per_number: 50,
      min_reply_rate: 30,
      max_unanswered_in_row: 3,
      burst_new_chats_10min: 10,
      quiet_hours_start: 22,
      quiet_hours_end: 8,
      timezone: 'UTC',
      notify: true,
      block_over_limit: false,
    });
  });
});

describe('inQuietHours', () => {
  it('wraps past midnight when the start is after the end', () => {
    expect(inQuietHours(22, 22, 8)).toBe(true);
    expect(inQuietHours(3, 22, 8)).toBe(true);
    expect(inQuietHours(7, 22, 8)).toBe(true);
    expect(inQuietHours(8, 22, 8)).toBe(false);
    expect(inQuietHours(21, 22, 8)).toBe(false);
  });

  it('is a plain window when the start is before the end', () => {
    expect(inQuietHours(1, 0, 6)).toBe(true);
    expect(inQuietHours(6, 0, 6)).toBe(false);
  });

  it('is off when start and end are equal', () => {
    for (let h = 0; h < 24; h++) expect(inQuietHours(h, 5, 5)).toBe(false);
  });
});

describe('isValidTimeZone', () => {
  it('knows IANA zones and nothing else', () => {
    expect(isValidTimeZone('Asia/Dubai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('refuses offsets, which Postgres reads with the sign reversed', () => {
    expect(isValidTimeZone('+04')).toBe(false);
    expect(isValidTimeZone('-05:00')).toBe(false);
    expect(isValidTimeZone('Etc/GMT-4')).toBe(true);
  });
});
