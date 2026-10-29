import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  layer: null as null | {
    gateway: { hasKey: () => boolean };
    config: { accounts: '*' | string[] };
  },
}));

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/typesafe', () => ({ getDecisionLayer: () => mocks.layer }));
vi.mock('@/lib/typesafe/config', () => ({
  accountEnabled: (config: { accounts: '*' | string[] }, id: string) =>
    config.accounts === '*' || config.accounts.includes(id),
}));

import { InsightSettingsStore, insightsAvailable } from './settings';
import {
  INSIGHT_SETTINGS_OFF,
  type InsightSettingsRow,
} from './settings-shape';

const row = (extra: Partial<InsightSettingsRow> = {}): InsightSettingsRow => ({
  account_id: 'a',
  signals_enabled: true,
  tag_suggest_mode: 'suggest',
  tag_auto_min_p: 0.85,
  reply_class_enabled: false,
  reply_interested_tag_id: null,
  compose_check_mode: 'off',
  meaning_triggers_enabled: false,
  kb_gap_judge_enabled: false,
  updated_at: 'v1',
  updated_by: null,
  ...extra,
});

describe('InsightSettingsStore', () => {
  let t = 0;
  beforeEach(() => {
    t = 0;
  });
  const now = () => t;

  it('reads no row as off and caches for 30 s', async () => {
    const read = vi.fn().mockResolvedValue(null);
    const s = new InsightSettingsStore({ read, now });
    expect(await s.get('a')).toEqual(INSIGHT_SETTINGS_OFF);
    t = 29_000;
    await s.get('a');
    expect(read).toHaveBeenCalledTimes(1);
    t = 31_000;
    await s.get('a');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serves the last value on a read error, else off, and never throws', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(row())
      .mockRejectedValueOnce(new Error('down'));
    const onError = vi.fn();
    const s = new InsightSettingsStore({ read, now, onError });
    expect(await s.get('a')).toEqual(INSIGHT_SETTINGS_OFF);
    t = 10_000; // past the 5 s error TTL
    expect((await s.get('a')).signalsEnabled).toBe(true);
    t = 50_000;
    expect((await s.get('a')).signalsEnabled).toBe(true);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a save wins over a read that was in flight', async () => {
    let resolve!: (r: InsightSettingsRow) => void;
    const read = vi.fn(
      () => new Promise<InsightSettingsRow>((r) => (resolve = r))
    );
    const s = new InsightSettingsStore({ read, now });
    const pending = s.get('a');
    const saved = {
      ...INSIGHT_SETTINGS_OFF,
      composeCheckMode: 'warn' as const,
    };
    s.set('a', saved);
    resolve(row({ compose_check_mode: 'off' }));
    expect(await pending).toEqual(saved);
    expect(await s.get('a')).toEqual(saved);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('insightsAvailable', () => {
  it('needs the layer, a key and the account allowed', () => {
    mocks.layer = null;
    expect(insightsAvailable('a')).toBe(false);
    mocks.layer = {
      gateway: { hasKey: () => false },
      config: { accounts: '*' },
    };
    expect(insightsAvailable('a')).toBe(false);
    mocks.layer = {
      gateway: { hasKey: () => true },
      config: { accounts: ['b'] },
    };
    expect(insightsAvailable('a')).toBe(false);
    mocks.layer = {
      gateway: { hasKey: () => true },
      config: { accounts: ['a'] },
    };
    expect(insightsAvailable('a')).toBe(true);
  });
});
