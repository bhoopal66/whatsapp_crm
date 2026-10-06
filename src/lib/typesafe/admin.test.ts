import { describe, expect, it } from 'vitest';
import {
  SETTINGS_DEFAULTS,
  activityCursor,
  actsLive,
  effectivePolicies,
  parseActivityCursor,
  type ActivePolicyRow,
  parseActivityQuery,
  parseSettingsUpdate,
  rowFromUpdate,
  serverStatus,
  settingsFromRow,
} from './admin';

const ACCT = '11111111-1111-4111-8111-111111111111';
const NO_POLICIES: ActivePolicyRow[] = [];
const VALID = {
  enabled: true,
  mode: 'live',
  triage: true,
  guardrail: true,
  passages: false,
  watchHumanThreads: true,
  languages: 'all',
  expectedUpdatedAt: null,
};

describe('parseSettingsUpdate', () => {
  it('accepts a complete body', () => {
    expect(parseSettingsUpdate(VALID)).toEqual({
      ok: true,
      value: { ...VALID, confirmLive: false },
    });
    expect(
      parseSettingsUpdate({
        ...VALID,
        expectedUpdatedAt: '2026-09-29T11:01:30.123456+00:00',
        confirmLive: true,
      })
    ).toMatchObject({
      ok: true,
      value: {
        expectedUpdatedAt: '2026-09-29T11:01:30.123456+00:00',
        confirmLive: true,
      },
    });
  });

  it.each([
    ['a missing field', { ...VALID, guardrail: undefined }],
    ['a string boolean', { ...VALID, enabled: 'true' }],
    ['an unknown mode', { ...VALID, mode: 'shadow' }],
    ['an unknown language setting', { ...VALID, languages: 'ar' }],
    ['no expected version', { ...VALID, expectedUpdatedAt: undefined }],
    ['a non-boolean confirmation', { ...VALID, confirmLive: 'yes' }],
  ])('refuses %s', (_label, body) => {
    expect(parseSettingsUpdate(body).ok).toBe(false);
  });

  it.each([null, 'x', [VALID], 1])('refuses a non-object: %j', (body) => {
    expect(parseSettingsUpdate(body).ok).toBe(false);
  });

  it('drops unknown fields rather than writing them', () => {
    const r = parseSettingsUpdate({ ...VALID, account_id: 'other' });
    expect(r.ok && Object.keys(r.value)).not.toContain('account_id');
    expect(rowFromUpdate(ACCT, VALID as never).account_id).toBe(ACCT);
  });
});

describe('settingsFromRow', () => {
  it('is off with safe defaults when the account never saved', () => {
    expect(settingsFromRow(null, null)).toEqual({
      ...SETTINGS_DEFAULTS,
      enabled: false,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('maps the columns', () => {
    expect(
      settingsFromRow(
        {
          enabled: true,
          mode: 'live',
          triage: true,
          guardrail: false,
          passages: true,
          watch_human_threads: false,
          languages: 'all',
          updated_at: '2026-09-29T10:00:00Z',
          updated_by: 'u1',
        },
        'Admin'
      )
    ).toEqual({
      enabled: true,
      mode: 'live',
      triage: true,
      guardrail: false,
      passages: true,
      watchHumanThreads: false,
      languages: 'all',
      updatedAt: '2026-09-29T10:00:00Z',
      updatedBy: 'Admin',
    });
  });
});

describe('serverStatus', () => {
  const KEYS = { TYPESAFE_API_KEY: 'k', TS_LOG_HASH_KEY: 'x'.repeat(32) };

  it('is not configured without an API key', () => {
    expect(serverStatus(ACCT, NO_POLICIES, {})).toMatchObject({
      configured: false,
      problem: null,
      checksAvailable: { triage: false, guardrail: false, passages: false },
    });
  });

  it('is configured with the keys, for any account', () => {
    expect(serverStatus(ACCT, NO_POLICIES, KEYS)).toMatchObject({
      configured: true,
      problem: null,
      forcedMonitor: { triage: false, guardrail: false, passages: false },
      accountAllowed: true,
      checksAvailable: { triage: true, guardrail: true, passages: true },
      model: 'jev-1.13.0',
      failMode: 'hold',
    });
  });

  it('reports install-wide overrides', () => {
    const s = serverStatus(ACCT, NO_POLICIES, {
      ...KEYS,
      TS_SHADOW: 'true',
      TS_ENABLED_PASSAGES: 'false',
      TS_ACCOUNT_IDS: '22222222-2222-4222-8222-222222222222',
    });
    expect(s.forcedMonitor).toEqual({
      triage: true,
      guardrail: true,
      passages: true,
    });
    expect(s.checksAvailable.passages).toBe(false);
    expect(s.accountAllowed).toBe(false);
  });

  it('reports an invalid variable as the problem instead of throwing', () => {
    const s = serverStatus(ACCT, NO_POLICIES, {
      ...KEYS,
      TS_SHADOW: 'true # comment',
    });
    expect(s.configured).toBe(false);
    expect(s.problem).toMatch(/TS_SHADOW/);
  });

  it('never echoes a secret', () => {
    const s = JSON.stringify(
      serverStatus(ACCT, NO_POLICIES, {
        TYPESAFE_API_KEY: 'sk-secret-value',
        TS_LOG_HASH_KEY: 'short-secret',
      })
    );
    expect(s).not.toContain('sk-secret-value');
    expect(s).not.toContain('short-secret');
  });
});

describe('parseActivityQuery', () => {
  const q = (s: string) => parseActivityQuery(new URLSearchParams(s));

  it('defaults', () => {
    expect(q('')).toEqual({
      days: 7,
      check: null,
      acted: null,
      limit: 50,
      before: null,
    });
  });

  it('reads and bounds the filters', () => {
    expect(
      q(
        'days=500&check=guardrail&acted=true&limit=1000&before=2026-09-29T10:00:00Z'
      )
    ).toEqual({
      days: 90,
      check: 'guardrail',
      acted: true,
      limit: 100,
      before: { at: '2026-09-29T10:00:00Z', id: null },
    });
    expect(
      q('check=eligibility&acted=maybe&before=yesterday&days=0')
    ).toMatchObject({ check: null, acted: null, before: null, days: 7 });
  });
});

describe('activity cursor', () => {
  const row = {
    created_at: '2026-09-29T11:01:30.123456+00:00',
    id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  };

  it('round-trips the exact timestamp and the id', () => {
    expect(parseActivityCursor(activityCursor(row))).toEqual({
      at: row.created_at,
      id: row.id,
    });
    // Through a query string, as the panel sends it.
    const params = new URLSearchParams({ before: activityCursor(row) });
    expect(
      parseActivityQuery(new URLSearchParams(params.toString())).before
    ).toEqual({ at: row.created_at, id: row.id });
  });

  it.each([
    '2026-09-29T11:01:30Z~not-a-uuid',
    '2026-09-29T11:01:30Z",id.gt.0~' + row.id,
    '2026-09-29 11:01:30',
    '2026-09-29T11:01:30Z~' + row.id + '~x',
    '2026-13-45T11:01:30Z',
  ])('refuses a malformed cursor: %s', (raw) => {
    expect(parseActivityCursor(raw)).toBeNull();
  });
});

describe('forced monitor per check', () => {
  it('names only the checks the server forces', () => {
    const s = serverStatus(ACCT, NO_POLICIES, {
      TYPESAFE_API_KEY: 'k',
      TS_LOG_HASH_KEY: 'x'.repeat(32),
      TS_SHADOW_GUARDRAIL: 'true',
    });
    expect(s.forcedMonitor).toEqual({
      triage: false,
      guardrail: true,
      passages: false,
    });
  });
});

describe('effectivePolicies', () => {
  const row = (over: Partial<ActivePolicyRow>): ActivePolicyRow => ({
    check_name: 'guardrail',
    version: 2,
    model_id: 'jev-1.13.0',
    question_set_version: 'qs-013-v0.2',
    thresholds: { actionMin: 0.7, reviewMin: 0.35, severityBlock: 2 },
    shadow: false,
    ...over,
  });
  const config = { model: 'jev-1.13.0' };

  it('reports an approved policy the layer applies', () => {
    expect(effectivePolicies([row({})], config)).toEqual({
      triage: null,
      guardrail: { version: 2, loggedOnly: false },
      passages: null,
    });
    expect(
      effectivePolicies([row({ shadow: true })], config).guardrail
    ).toEqual({ version: 2, loggedOnly: true });
  });

  it.each([
    ['another model', { model_id: 'jev-1.12.0' }],
    ['another question set', { question_set_version: 'qs-013-v0.1' }],
    ['invalid thresholds', { thresholds: { actionMin: 7 } }],
    ['an unknown check', { check_name: 'eligibility' }],
  ])('reports built-in for a policy for %s', (_label, over) => {
    expect(effectivePolicies([row(over)], config)).toEqual({
      triage: null,
      guardrail: null,
      passages: null,
    });
  });
});

describe('actsLive', () => {
  it('is on and Live only', () => {
    expect(actsLive({ enabled: true, mode: 'live' })).toBe(true);
    expect(actsLive({ enabled: false, mode: 'live' })).toBe(false);
    expect(actsLive({ enabled: true, mode: 'monitor' })).toBe(false);
  });
});
