import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMPOSE_CHECK_MODES,
  INSIGHT_SETTINGS_OFF,
  TAG_AUTO_MIN_P_DEFAULT,
  TAG_AUTO_MIN_P_MAX,
  TAG_AUTO_MIN_P_MIN,
  TAG_SUGGEST_MODES,
  parseInsightSettingsPut,
  rowFromValues,
  settingsDiffer,
  settingsFromRow,
} from './settings-shape';

const TAG = '6f1c2a34-1b2c-4d5e-8f90-123456789abc';

const body = (extra: Record<string, unknown> = {}) => ({
  signalsEnabled: true,
  tagSuggestMode: 'auto',
  tagAutoMinP: 0.9,
  replyClassEnabled: true,
  replyInterestedTagId: TAG,
  composeCheckMode: 'warn',
  meaningTriggersEnabled: false,
  kbGapJudgeEnabled: false,
  expectedUpdatedAt: null,
  ...extra,
});

describe('settingsFromRow', () => {
  it('reads no row as everything off', () => {
    expect(settingsFromRow(null)).toEqual(INSIGHT_SETTINGS_OFF);
    expect(INSIGHT_SETTINGS_OFF).toMatchObject({
      signalsEnabled: false,
      tagSuggestMode: 'off',
      composeCheckMode: 'off',
      updatedAt: null,
    });
  });

  it('maps a row and rounds the real column', () => {
    expect(
      settingsFromRow({
        signals_enabled: true,
        tag_suggest_mode: 'suggest',
        tag_auto_min_p: 0.8500000238,
        reply_class_enabled: true,
        reply_interested_tag_id: TAG,
        compose_check_mode: 'warn',
        meaning_triggers_enabled: true,
        kb_gap_judge_enabled: true,
        updated_at: 'v1',
      })
    ).toEqual({
      signalsEnabled: true,
      tagSuggestMode: 'suggest',
      tagAutoMinP: 0.85,
      replyClassEnabled: true,
      replyInterestedTagId: TAG,
      composeCheckMode: 'warn',
      meaningTriggersEnabled: true,
      kbGapJudgeEnabled: true,
      updatedAt: 'v1',
    });
  });

  it('reads an unknown mode or out-of-range probability as off / default', () => {
    const s = settingsFromRow({
      tag_suggest_mode: 'always',
      compose_check_mode: 'block',
      tag_auto_min_p: 0.2,
    });
    expect(s.tagSuggestMode).toBe('off');
    expect(s.composeCheckMode).toBe('off');
    expect(s.tagAutoMinP).toBe(TAG_AUTO_MIN_P_DEFAULT);
  });
});

describe('parseInsightSettingsPut', () => {
  it('accepts a full body', () => {
    const r = parseInsightSettingsPut(body());
    expect(r).toEqual({ ok: true, value: body() });
  });

  it.each([
    ['not an object', null],
    ['a missing switch', body({ signalsEnabled: undefined })],
    ['an unknown tag mode', body({ tagSuggestMode: 'always' })],
    ['an unknown compose mode', body({ composeCheckMode: 'block' })],
    ['a probability below the floor', body({ tagAutoMinP: 0.5 })],
    ['a probability above the ceiling', body({ tagAutoMinP: 1 })],
    ['a non-uuid tag', body({ replyInterestedTagId: 'interested' })],
    ['a numeric version', body({ expectedUpdatedAt: 3 })],
  ])('refuses %s', (_label, input) => {
    expect(parseInsightSettingsPut(input).ok).toBe(false);
  });
});

describe('rowFromValues', () => {
  it('names every column the migration defines, except the stamp', () => {
    const parsed = parseInsightSettingsPut(body());
    if (!parsed.ok) throw new Error(parsed.error);
    // The parsed body still carries expectedUpdatedAt: it must not leak
    // into the row.
    expect(rowFromValues('acct', 'user', parsed.value)).toEqual({
      account_id: 'acct',
      signals_enabled: true,
      tag_suggest_mode: 'auto',
      tag_auto_min_p: 0.9,
      reply_class_enabled: true,
      reply_interested_tag_id: TAG,
      compose_check_mode: 'warn',
      meaning_triggers_enabled: false,
      kb_gap_judge_enabled: false,
      updated_by: 'user',
    });
    const values = parsed.value;
    expect(settingsDiffer(values, values)).toBe(false);
    expect(settingsDiffer(values, { ...values, tagAutoMinP: 0.91 })).toBe(true);
  });
});

describe('mirrors migration 147', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/147_smart_insights.sql'),
    'utf8'
  );
  it('has the same modes and probability bounds as the CHECKs', () => {
    expect(sql).toContain(
      `tag_suggest_mode IN (${TAG_SUGGEST_MODES.map((m) => `'${m}'`).join(', ')})`
    );
    expect(sql).toContain(
      `compose_check_mode IN (${COMPOSE_CHECK_MODES.map((m) => `'${m}'`).join(', ')})`
    );
    expect(sql).toContain(
      `tag_auto_min_p BETWEEN ${TAG_AUTO_MIN_P_MIN} AND ${TAG_AUTO_MIN_P_MAX}`
    );
    expect(sql).toContain(`DEFAULT ${TAG_AUTO_MIN_P_DEFAULT}`);
  });
});
