/**
 * Server-side helpers behind Settings → AI Agents → Safety checks
 * (`/api/typesafe/settings`, `/api/typesafe/activity`). Pure: the routes
 * own the database and the auth; everything here is testable without
 * either.
 */
import type {
  PartnerBanksSetting,
  TsAccountSettings,
  TsCheck,
  TsPolicyInfo,
  TsSettingsPut,
  TsSettingsUpdate,
  TsStatus,
} from './admin-types';
import {
  DEFAULT_CONFIG,
  accountEnabled,
  isShadow,
  loadConfig,
  type Ts013Config,
} from './config';
import { validateThresholds } from './policy';
import { QS_VERSION } from './questions/triage';

/** What an account that never saved its switches sees: off. */
export const SETTINGS_DEFAULTS: TsSettingsUpdate = {
  enabled: false,
  mode: 'monitor',
  triage: true,
  guardrail: true,
  passages: false,
  watchHumanThreads: true,
  languages: 'english',
};

/** A `ts_account_settings` row as PostgREST returns it. */
export interface SettingsRow {
  enabled: boolean;
  mode: string;
  triage: boolean;
  guardrail: boolean;
  passages: boolean;
  watch_human_threads: boolean;
  languages: string;
  /** Migration 078; NULL = the built-in list. Only in
   *  SETTINGS_COLUMNS_078, so absent from a SETTINGS_COLUMNS read. Read
   *  it through parsePartnerBanks: the CHECK holds only the envelope. */
  partner_banks?: PartnerBanksSetting | null;
  updated_at: string | null;
  updated_by: string | null;
}

export const SETTINGS_COLUMNS =
  'enabled, mode, triage, guardrail, passages, watch_human_threads, languages, updated_at, updated_by';

/**
 * SETTINGS_COLUMNS plus partner_banks (migration 078). A database that
 * has not run 078 rejects it (isUndefinedColumn in ./store): retry with
 * SETTINGS_COLUMNS, which reads as the built-in list. SETTINGS_COLUMNS
 * itself stays pre-078 so a route still using it keeps working there;
 * a save read back without the column leaves the decision layer's
 * partner banks as they were (SwitchesStore.set).
 */
export const SETTINGS_COLUMNS_078 = `${SETTINGS_COLUMNS}, partner_banks`;

export function settingsFromRow(
  row: SettingsRow | null,
  updatedByName: string | null
): TsAccountSettings {
  if (!row) return { ...SETTINGS_DEFAULTS, updatedAt: null, updatedBy: null };
  return {
    enabled: row.enabled,
    mode: row.mode === 'live' ? 'live' : 'monitor',
    triage: row.triage,
    guardrail: row.guardrail,
    passages: row.passages,
    watchHumanThreads: row.watch_human_threads,
    languages: row.languages === 'all' ? 'all' : 'english',
    updatedAt: row.updated_at,
    updatedBy: updatedByName,
  };
}

export function rowFromUpdate(accountId: string, u: TsSettingsUpdate) {
  return {
    account_id: accountId,
    enabled: u.enabled,
    mode: u.mode,
    triage: u.triage,
    guardrail: u.guardrail,
    passages: u.passages,
    watch_human_threads: u.watchHumanThreads,
    languages: u.languages,
  };
}

const BOOLEAN_FIELDS = [
  'enabled',
  'triage',
  'guardrail',
  'passages',
  'watchHumanThreads',
] as const;

/**
 * Validates a PUT body. Every switch is required — the panel always
 * sends the whole set, and a partial body is more likely a bug than an
 * intent — and so is `expectedUpdatedAt` (null for a first save).
 * Returns the body, or an error message for a 400.
 */
export function parseSettingsUpdate(
  body: unknown
): { ok: true; value: TsSettingsPut } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, error: 'Expected a JSON object' };
  const b = body as Record<string, unknown>;
  for (const f of BOOLEAN_FIELDS)
    if (typeof b[f] !== 'boolean')
      return { ok: false, error: `"${f}" must be true or false` };
  if (b.mode !== 'monitor' && b.mode !== 'live')
    return { ok: false, error: '"mode" must be "monitor" or "live"' };
  if (b.languages !== 'english' && b.languages !== 'all')
    return { ok: false, error: '"languages" must be "english" or "all"' };
  if (b.expectedUpdatedAt !== null && typeof b.expectedUpdatedAt !== 'string')
    return {
      ok: false,
      error: '"expectedUpdatedAt" must be the last updatedAt, or null',
    };
  if (b.confirmLive !== undefined && typeof b.confirmLive !== 'boolean')
    return { ok: false, error: '"confirmLive" must be true or false' };
  return {
    ok: true,
    value: {
      enabled: b.enabled as boolean,
      mode: b.mode,
      triage: b.triage as boolean,
      guardrail: b.guardrail as boolean,
      passages: b.passages as boolean,
      watchHumanThreads: b.watchHumanThreads as boolean,
      languages: b.languages,
      expectedUpdatedAt: b.expectedUpdatedAt as string | null,
      confirmLive: b.confirmLive === true,
    },
  };
}

/** The layer acts for the account: on, and Live. */
export const actsLive = (s: Pick<TsSettingsUpdate, 'enabled' | 'mode'>) =>
  s.enabled && s.mode === 'live';

/** An active `ts_policy` row, as the settings route reads it. */
export interface ActivePolicyRow {
  check_name: string;
  version: number;
  model_id: string;
  question_set_version: string;
  thresholds: unknown;
  shadow: boolean;
}

/**
 * The custom thresholds actually in effect per check, as the layer's
 * PolicyStore resolves them: a policy for another model or question set,
 * or with invalid thresholds, is ignored in favour of the built-in ones.
 */
export function effectivePolicies(
  rows: ActivePolicyRow[],
  config: Pick<Ts013Config, 'model'>
): Record<TsCheck, TsPolicyInfo | null> {
  const out: Record<TsCheck, TsPolicyInfo | null> = {
    triage: null,
    guardrail: null,
    passages: null,
  };
  for (const r of rows) {
    if (!(ACTIVITY_CHECKS as readonly string[]).includes(r.check_name))
      continue;
    const check = r.check_name as TsCheck;
    if (r.model_id !== config.model || r.question_set_version !== QS_VERSION)
      continue;
    try {
      validateThresholds(check, r.thresholds);
    } catch {
      continue;
    }
    out[check] = { version: r.version, loggedOnly: r.shadow };
  }
  return out;
}

/**
 * What this server offers, from its environment. Never throws: an
 * invalid variable is reported as the `problem`, which is exactly what
 * the layer does with it (it stays off — see getDecisionLayer).
 */
export function serverStatus(
  accountId: string,
  policyRows: ActivePolicyRow[],
  env: Record<string, string | undefined> = process.env
): TsStatus {
  try {
    const config = loadConfig(env);
    const configured = Boolean(
      env.TYPESAFE_API_KEY?.trim() && config.logHashKey
    );
    return {
      configured,
      problem: null,
      model: config.model,
      failMode: config.guardrailFailMode,
      forcedMonitor: {
        triage: isShadow(config, 'triage'),
        guardrail: isShadow(config, 'guardrail'),
        passages: isShadow(config, 'passages'),
      },
      checksAvailable: {
        triage: config.enabled.triage,
        guardrail: config.enabled.guardrail,
        passages: config.enabled.passages,
      },
      accountAllowed: accountEnabled(config, accountId),
      policies: effectivePolicies(policyRows, config),
    };
  } catch (err) {
    return {
      configured: false,
      problem: err instanceof Error ? err.message : String(err),
      model: DEFAULT_CONFIG.model,
      failMode: DEFAULT_CONFIG.guardrailFailMode,
      forcedMonitor: { triage: false, guardrail: false, passages: false },
      checksAvailable: { triage: false, guardrail: false, passages: false },
      // Unknown while the configuration is unreadable; the panel keeps
      // the switches usable so an admin can stand the guardrail down.
      accountAllowed: true,
      policies: effectivePolicies(policyRows, DEFAULT_CONFIG),
    };
  }
}

export const ACTIVITY_CHECKS: readonly TsCheck[] = [
  'triage',
  'guardrail',
  'passages',
];

export interface ActivityCursor {
  /** created_at exactly as the database returned it (microseconds kept). */
  at: string;
  /** Tie-breaker for rows with the same created_at. */
  id: string | null;
}

export interface ActivityQuery {
  days: number;
  check: TsCheck | null;
  acted: boolean | null;
  limit: number;
  before: ActivityCursor | null;
}

// Strict shapes: the cursor is spliced into a PostgREST filter.
const CURSOR_AT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURSOR_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `nextBefore` for the last row of a page: its created_at and id. */
export function activityCursor(row: {
  created_at: string;
  id: string;
}): string {
  return `${row.created_at}~${row.id}`;
}

/** Reads a cursor from activityCursor (or a bare timestamp); null if malformed. */
export function parseActivityCursor(raw: string | null): ActivityCursor | null {
  if (!raw) return null;
  const [at, id, ...rest] = raw.split('~');
  if (rest.length || !at || !CURSOR_AT.test(at) || Number.isNaN(Date.parse(at)))
    return null;
  if (id !== undefined && !CURSOR_ID.test(id)) return null;
  return { at, id: id ?? null };
}

/** Reads `?days=&check=&acted=&limit=&before=`; out-of-range values fall back. */
export function parseActivityQuery(params: URLSearchParams): ActivityQuery {
  const rawDays = Number(params.get('days'));
  const days =
    Number.isFinite(rawDays) && rawDays >= 1
      ? Math.min(90, Math.floor(rawDays))
      : 7;
  const rawCheck = params.get('check');
  const check = (ACTIVITY_CHECKS as readonly string[]).includes(rawCheck ?? '')
    ? (rawCheck as TsCheck)
    : null;
  const rawActed = params.get('acted');
  const acted =
    rawActed === 'true' ? true : rawActed === 'false' ? false : null;
  const rawLimit = Number(params.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(100, Math.floor(rawLimit))
      : 50;
  return {
    days,
    check,
    acted,
    limit,
    before: parseActivityCursor(params.get('before')),
  };
}
