import { describe, expect, it } from 'vitest';

import {
  KB_LEARN_SETTINGS_OFF,
  isLearnedEntry,
  kbLearnSettingsFrom,
  parseKbLearnPut,
  parseKbLearnResponse,
} from './learn-settings';

describe('kbLearnSettingsFrom', () => {
  it('reads no row as off', () => {
    expect(kbLearnSettingsFrom(null)).toEqual(KB_LEARN_SETTINGS_OFF);
    expect(KB_LEARN_SETTINGS_OFF.enabled).toBe(false);
  });
  it('reads a row, and a bad count as unknown', () => {
    expect(
      kbLearnSettingsFrom({
        enabled: true,
        last_run_at: '2026-11-20T08:00:00Z',
        last_run_drafted: 3,
      })
    ).toEqual({
      enabled: true,
      lastRunAt: '2026-11-20T08:00:00Z',
      lastRunDrafted: 3,
      available: true,
    });
    expect(
      kbLearnSettingsFrom({ enabled: 'yes', last_run_drafted: -1 })
    ).toMatchObject({ enabled: false, lastRunDrafted: null });
  });
});

describe('parseKbLearnResponse', () => {
  it('reads the route’s answer', () => {
    expect(
      parseKbLearnResponse({
        enabled: true,
        lastRunAt: '2026-11-20T08:00:00Z',
        lastRunDrafted: 0,
        available: true,
      })
    ).toEqual({
      enabled: true,
      lastRunAt: '2026-11-20T08:00:00Z',
      lastRunDrafted: 0,
      available: true,
    });
  });
  it('reads junk as off, and keeps "not applied"', () => {
    expect(parseKbLearnResponse('nope')).toEqual(KB_LEARN_SETTINGS_OFF);
    expect(parseKbLearnResponse({ available: false }).available).toBe(false);
  });
});

describe('parseKbLearnPut', () => {
  it('takes a boolean only', () => {
    expect(parseKbLearnPut({ enabled: true })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(parseKbLearnPut({ enabled: 1 }).ok).toBe(false);
    expect(parseKbLearnPut([]).ok).toBe(false);
  });
});

describe('isLearnedEntry', () => {
  it('is the learned source only', () => {
    expect(isLearnedEntry({ source: 'learned' })).toBe(true);
    expect(isLearnedEntry({ source: 'knowledge_gap' })).toBe(false);
    expect(isLearnedEntry({ source: null })).toBe(false);
  });
});
