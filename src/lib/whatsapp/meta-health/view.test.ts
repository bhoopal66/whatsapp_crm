import { describe, expect, it } from 'vitest';

import {
  assessedTone,
  marketingUsage,
  parseAssessedState,
  parseCostPerWonCase,
  parseReasons,
  qualityTone,
  utcDay,
} from './view';

describe('meta health view helpers', () => {
  it('maps the assessed state to a tone, unknown states to NORMAL', () => {
    expect(assessedTone(parseAssessedState('ALL_PAUSED'))).toBe('destructive');
    expect(assessedTone(parseAssessedState('THROTTLED'))).toBe('warning');
    expect(assessedTone(parseAssessedState('MARKETING_PAUSED'))).toBe(
      'warning'
    );
    expect(parseAssessedState('bogus')).toBe('NORMAL');
    expect(assessedTone('NORMAL')).toBe('success');
  });

  it('colours quality like Meta does', () => {
    expect(qualityTone('GREEN')).toBe('success');
    expect(qualityTone('YELLOW')).toBe('warning');
    expect(qualityTone('RED')).toBe('destructive');
    expect(qualityTone('UNKNOWN')).toBe('muted');
    expect(qualityTone(null)).toBe('muted');
  });

  it('keeps string reasons and an object reason text, drops the rest', () => {
    expect(
      parseReasons([
        ' quality_red ',
        { code: 'tier_drop' },
        { message: 'Paused by Meta', code: 'x' },
        42,
        '',
        null,
      ])
    ).toEqual(['quality_red', 'tier_drop', 'Paused by Meta']);
    expect(parseReasons('nope')).toEqual([]);
  });

  it('uses the UTC date the SQL counts over', () => {
    // 23:30 in Dubai on the 10th is still the 10th in UTC at 19:30.
    expect(utcDay(new Date('2026-11-10T19:30:00Z'))).toBe('2026-11-10');
    // 02:00 Dubai on the 11th is 22:00 UTC on the 10th.
    expect(utcDay(new Date('2026-11-10T22:00:00Z'))).toBe('2026-11-10');
  });

  it('parses the cost-per-won-case jsonb, numeric strings included', () => {
    expect(
      parseCostPerWonCase({
        won_cases: 3,
        won_spend_usd: '1.2',
        cost_per_won_case_usd: null,
        other_spend_usd: 0.5,
        unknown_cost_messages: 1,
      })
    ).toEqual({
      wonCases: 3,
      wonSpendUsd: 1.2,
      costPerWonCaseUsd: null,
      otherSpendUsd: 0.5,
      unknownCostMessages: 1,
    });
    expect(parseCostPerWonCase(null)).toBeNull();
    expect(parseCostPerWonCase([1])).toBeNull();
  });

  it('flags the advisory cap once reached, never without one', () => {
    expect(marketingUsage(5, 5).atCap).toBe(true);
    expect(marketingUsage(4, 5).atCap).toBe(false);
    expect(marketingUsage(999, null).atCap).toBe(false);
    expect(marketingUsage(null, 3)).toEqual({ sent: 0, cap: 3, atCap: false });
  });
});
