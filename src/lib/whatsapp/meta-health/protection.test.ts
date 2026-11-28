import { describe, expect, it } from 'vitest';

import ar from '../../../../messages/ar.json';
import en from '../../../../messages/en.json';
import ko from '../../../../messages/ko.json';
import { canEnforceSendProtection } from '@/lib/auth/roles';
import { GUARD_REASONS } from './guard';
import {
  isCapValue,
  knownReason,
  microsToUnits,
  parseCountCap,
  parseDecisions,
  readMicros,
  unitsToMicros,
} from './protection';

type Catalogue = {
  Settings: { sendProtection: { reasons: Record<string, string> } };
};

describe('reason words', () => {
  it.each([
    ['en', en],
    ['ar', ar],
    ['ko', ko],
  ])('every GUARD_REASONS value has a %s string', (_l, catalogue) => {
    const reasons = (catalogue as unknown as Catalogue).Settings.sendProtection
      .reasons;
    for (const r of Object.values(GUARD_REASONS)) {
      expect(typeof reasons[r], r).toBe('string');
      expect(reasons[r].length, r).toBeGreaterThan(0);
    }
  });

  it('knows the guard reasons and nothing else', () => {
    expect(knownReason('SPEND_CAP')).toBe('SPEND_CAP');
    expect(knownReason('SOMETHING_NEW')).toBeNull();
    expect(knownReason(3)).toBeNull();
  });
});

describe('canEnforceSendProtection', () => {
  it('is the owner alone', () => {
    expect(canEnforceSendProtection('owner')).toBe(true);
    for (const r of ['admin', 'team_leader', 'agent', 'viewer'] as const) {
      expect(canEnforceSendProtection(r), r).toBe(false);
    }
  });
});

describe('unitsToMicros / microsToUnits', () => {
  it('converts on the digits', () => {
    expect(unitsToMicros('')).toEqual({ ok: true, micros: null });
    expect(unitsToMicros(' 12 ')).toEqual({ ok: true, micros: 12_000_000 });
    expect(unitsToMicros('0.29')).toEqual({ ok: true, micros: 290_000 });
    expect(unitsToMicros('1.000001')).toEqual({ ok: true, micros: 1_000_001 });
  });
  it('refuses what is not a non-negative amount', () => {
    for (const s of ['-1', '1.2345678', 'abc', '1e3', '1,5', '.5']) {
      expect(unitsToMicros(s), s).toEqual({ ok: false });
    }
    expect(unitsToMicros('99999999999999')).toEqual({ ok: false });
  });
  it('round-trips', () => {
    expect(microsToUnits(null)).toBe('');
    expect(microsToUnits(290_000)).toBe('0.29');
    expect(microsToUnits(12_000_000)).toBe('12');
    expect(unitsToMicros(microsToUnits(1_234_567))).toEqual({
      ok: true,
      micros: 1_234_567,
    });
  });
  it('reads stored micros', () => {
    expect(readMicros(null)).toBeNull();
    expect(readMicros('5000000')).toBe(5_000_000);
    expect(readMicros(-1)).toBeNull();
  });
});

describe('parseCountCap / isCapValue', () => {
  it('parses a whole number or empty', () => {
    expect(parseCountCap('')).toEqual({ ok: true, cap: null });
    expect(parseCountCap('250')).toEqual({ ok: true, cap: 250 });
    expect(parseCountCap('2.5')).toEqual({ ok: false });
    expect(parseCountCap('3000000000')).toEqual({ ok: false });
  });
  it('accepts null or a non-negative integer', () => {
    expect(isCapValue(null)).toBe(true);
    expect(isCapValue(0)).toBe(true);
    expect(isCapValue(-1)).toBe(false);
    expect(isCapValue(1.5)).toBe(false);
    expect(isCapValue('5')).toBe(false);
    expect(isCapValue(10, 5)).toBe(false);
  });
});

describe('parseDecisions', () => {
  it('keeps well-formed rows and drops the rest', () => {
    const good = {
      id: 1,
      at: '2026-11-28T10:00:00Z',
      decision: 'DEFER',
      reason: 'RAMP_CAP_REACHED',
      template: 'promo',
      enforced: false,
    };
    const rows = parseDecisions([
      good,
      { id: 2, at: '2026-11-28T10:00:00Z', decision: 'MAYBE', reason: 'X' },
      null,
    ]);
    expect(rows).toEqual([good]);
    expect(parseDecisions(null)).toEqual([]);
  });
});
