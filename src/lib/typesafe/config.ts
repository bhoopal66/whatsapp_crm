/**
 * Module 013 server configuration: what the layer MAY do on this
 * install. Whether it DOES, per account, is the account's own switch in
 * Settings → AI safety checks (ts_account_settings, migration 064; see
 * `AccountSwitches`).
 *
 * With no TYPESAFE_API_KEY nothing is available. With a key, every check
 * is available unless its TS_ENABLED_<CHECK>=false turns it off for the
 * whole install; TS_SHADOW=true forces monitor-only for every account;
 * TS_ACCOUNT_IDS, when set, limits which accounts may turn it on.
 */
import type { PartnerBanksSetting } from './admin-types';

export type CheckName = 'triage' | 'guardrail' | 'passages' | 'eligibility';
export const CHECK_NAMES: readonly CheckName[] = [
  'triage',
  'guardrail',
  'passages',
  'eligibility',
];

export type GuardrailFailMode = 'hold' | 'send';
/**
 * `other` is any script besides Arabic and Latin (Devanagari, Malayalam,
 * Cyrillic, CJK…) — languages no calibration has covered. `unknown` is
 * text with no letters at all (emoji, digits).
 */
export type Language = 'en' | 'ar' | 'mixed' | 'other' | 'unknown';
const LANGUAGES: readonly Language[] = [
  'en',
  'ar',
  'mixed',
  'other',
  'unknown',
];

export interface Ts013Config {
  /** Pinned model ID. Thresholds are only valid for this ID. */
  model: string;
  /** Per-check availability on this install. An unavailable check never
   *  calls TypeSafe, whatever an account's switches say. */
  enabled: Record<CheckName, boolean>;
  /**
   * Accounts the layer runs for (TS_ACCOUNT_IDS): `'*'` for every
   * account, or an explicit list. Anything else is never sent to
   * TypeSafe, never logged and never degraded — so switching a check on
   * for one tenant cannot move another tenant's customer text abroad.
   */
  accounts: '*' | string[];
  /** Install-wide monitor-only (TS_SHADOW=true): decisions are logged,
   *  never acted on, whatever an account chose. */
  shadow: boolean;
  /** Per-check override of `shadow` (TS_SHADOW_TRIAGE etc.). */
  shadowOverride?: Partial<Record<CheckName, boolean>>;
  /**
   * Languages kept logged-only for an account that chose "English only"
   * (the default), until they pass the spec §12 acceptance criteria.
   * "All languages" clears it.
   */
  shadowLanguages: Language[];
  /** Per-attempt timeout for hot-path checks (triage, passages, eligibility). */
  timeoutMs: number;
  /** Per-attempt timeout for the guardrail. */
  guardrailTimeoutMs: number;
  /** Retries after the first attempt on the hot path. */
  maxRetries: number;
  /** What to do with a bot reply when the guardrail is enabled but cannot run. */
  guardrailFailMode: GuardrailFailMode;
  /** Circuit breaker: open after N failures inside the window, for cooldown ms. */
  breaker: { failureThreshold: number; windowMs: number; cooldownMs: number };
  /** Max passages screened per query (spec: 6). */
  maxPassages: number;
  /** Concurrent passage requests — all of them at once, so one wave. */
  passageConcurrency: number;
  /** Secret for the decision log's state and message hashes (TS_LOG_HASH_KEY). */
  logHashKey?: string;
}

export const DEFAULT_CONFIG: Ts013Config = {
  model: 'jev-1.13.0',
  enabled: {
    triage: false,
    guardrail: false,
    passages: false,
    eligibility: false,
  },
  accounts: '*',
  shadow: false,
  shadowLanguages: ['ar', 'mixed', 'other'],
  timeoutMs: 2500,
  guardrailTimeoutMs: 3000,
  maxRetries: 1,
  guardrailFailMode: 'hold',
  breaker: { failureThreshold: 5, windowMs: 30_000, cooldownMs: 60_000 },
  maxPassages: 6,
  passageConcurrency: 6,
};

/** Upper bound for the per-attempt timeouts: the reply path must stay bounded. */
const MAX_TIMEOUT_MS = 10_000;
const PINNED_MODEL = /^jev-\d+\.\d+\.\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unset and blank both mean "use the default" — systemd keeps `X=` as ''. */
const str = (v: string | undefined): string | undefined => {
  const s = v?.trim();
  return s ? s : undefined;
};

const bool = (v: string | undefined, dflt: boolean, name: string): boolean => {
  const s = str(v)?.toLowerCase();
  if (s === undefined) return dflt;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`${name} must be true or false, got "${v}"`);
};

const int = (
  v: string | undefined,
  dflt: number,
  name: string,
  max: number
): number => {
  const s = str(v);
  if (s === undefined) return dflt;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0 || n > max)
    throw new Error(`${name} must be an integer from 1 to ${max}, got "${v}"`);
  return n;
};

/** True when decisions in this language must stay in shadow. */
export const languageShadowed = (
  config: Ts013Config,
  ...langs: Language[]
): boolean => langs.some((l) => config.shadowLanguages.includes(l));

function parseLanguages(v: string | undefined): Language[] {
  const s = str(v)?.toLowerCase();
  if (s === undefined) return [...DEFAULT_CONFIG.shadowLanguages];
  if (s === 'none') return [];
  const out = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const l of out)
    if (!LANGUAGES.includes(l as Language))
      throw new Error(`TS_SHADOW_LANGUAGES: unknown language "${l}"`);
  return out as Language[];
}

function parseAccounts(v: string | undefined): '*' | string[] {
  const s = str(v);
  if (s === undefined) return '*';
  if (s === '*') return '*';
  const ids = s
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  for (const id of ids)
    if (!UUID.test(id))
      throw new Error(`TS_ACCOUNT_IDS: "${id}" is not an account id`);
  return ids;
}

/** Effective shadow flag for one check: TS_SHADOW_<CHECK> if set, else TS_SHADOW. */
export const isShadow = (config: Ts013Config, check: CheckName): boolean =>
  config.shadowOverride?.[check] ?? config.shadow;

/**
 * One account's own switches (ts_account_settings, migration 064), as the
 * checks read them. No row means off.
 */
export interface AccountSwitches {
  enabled: boolean;
  mode: 'monitor' | 'live';
  checks: Record<CheckName, boolean>;
  /** Run triage on conversations people handle too (opt-outs only). */
  watchHumanThreads: boolean;
  languages: 'english' | 'all';
  /**
   * The account's row could not be read, and none was read before in
   * this process. Everything is off — except that the guardrail treats
   * it as "might be live" and holds (typesafe-gates.ts), so a read error
   * right after a restart cannot let an unscreened reply out.
   */
  unknown?: boolean;
  /**
   * The account's partner banks (migration 078), parsed: null means the
   * built-in list, and so does absent (a pre-078 database, a row read
   * without the column, or no row at all).
   */
  partnerBanks?: PartnerBanksSetting | null;
}

export const SWITCHES_OFF: AccountSwitches = {
  enabled: false,
  mode: 'monitor',
  checks: {
    triage: false,
    guardrail: false,
    passages: false,
    eligibility: false,
  },
  watchHumanThreads: false,
  languages: 'english',
};

/** Off, because the switches could not be read (see `unknown`). */
export const SWITCHES_UNKNOWN: AccountSwitches = {
  ...SWITCHES_OFF,
  unknown: true,
};

/**
 * What a layer with no database (tests, the evaluation harness) runs
 * with: everything on and live, so the install configuration alone
 * decides.
 */
export const SWITCHES_UNMANAGED: AccountSwitches = {
  enabled: true,
  mode: 'live',
  checks: { triage: true, guardrail: true, passages: true, eligibility: true },
  watchHumanThreads: true,
  languages: 'english',
};

/** The effective state of one check for one account. */
export interface CheckState {
  /** The check runs at all (TypeSafe is called and the decision logged). */
  on: boolean;
  /** Logged only: forced by the install, or the account chose monitor. */
  monitor: boolean;
  /** Languages kept logged-only for this account. */
  shadowLanguages: Language[];
  /** The account's switches could not be read (the check is off). */
  unknown: boolean;
}

export function checkState(
  config: Ts013Config,
  sw: AccountSwitches,
  check: CheckName,
  accountId: string
): CheckState {
  return {
    on:
      config.enabled[check] &&
      accountEnabled(config, accountId) &&
      sw.enabled &&
      sw.checks[check],
    monitor: isShadow(config, check) || sw.mode === 'monitor',
    shadowLanguages: sw.languages === 'all' ? [] : config.shadowLanguages,
    unknown: sw.unknown === true,
  };
}

/** True when the layer may run for this account at all (TS_ACCOUNT_IDS). */
export const accountEnabled = (
  config: Ts013Config,
  accountId: string
): boolean =>
  config.accounts === '*' ||
  config.accounts.includes(accountId.trim().toLowerCase());

/**
 * Reads TS_* variables. An invalid value throws: the host treats an
 * unreadable configuration as "layer off" and says so loudly (see
 * `getDecisionLayer` and src/instrumentation.ts), rather than guessing.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): Ts013Config {
  const failMode = (
    str(env.TS_GUARDRAIL_FAIL_MODE) ?? DEFAULT_CONFIG.guardrailFailMode
  ).toLowerCase();
  if (failMode !== 'hold' && failMode !== 'send') {
    throw new Error(
      `TS_GUARDRAIL_FAIL_MODE must be "hold" or "send", got "${failMode}"`
    );
  }
  // Thresholds are only valid for one exact model version, and TypeSafe
  // reports the versioned id — so an alias, a bare family name or a
  // two-part version could never match an approved policy.
  const model = str(env.TYPESAFE_MODEL) ?? DEFAULT_CONFIG.model;
  if (!PINNED_MODEL.test(model)) {
    throw new Error(
      `TYPESAFE_MODEL must be a pinned version like jev-1.13.0, got "${model}"`
    );
  }
  // With a key every check is available unless switched off here; each
  // account then decides for itself in Settings.
  const hasKey = str(env.TYPESAFE_API_KEY) !== undefined;
  const enabled: Record<CheckName, boolean> = {
    triage: bool(env.TS_ENABLED_TRIAGE, hasKey, 'TS_ENABLED_TRIAGE'),
    guardrail: bool(env.TS_ENABLED_GUARDRAIL, hasKey, 'TS_ENABLED_GUARDRAIL'),
    passages: bool(env.TS_ENABLED_PASSAGES, hasKey, 'TS_ENABLED_PASSAGES'),
    eligibility: bool(
      env.TS_ENABLED_ELIGIBILITY,
      hasKey,
      'TS_ENABLED_ELIGIBILITY'
    ),
  };
  const accounts = parseAccounts(env.TS_ACCOUNT_IDS);
  const logHashKey = str(env.TS_LOG_HASH_KEY);
  if (CHECK_NAMES.some((c) => enabled[c])) {
    // An enabled check without a key would fail every call — for the
    // guardrail that means degraded mode on every bot reply.
    if (!hasKey) {
      throw new Error(
        'TYPESAFE_API_KEY is required when any TS_ENABLED_* check is on'
      );
    }
    // Without it the logged state hash is a plain SHA-256, and a short
    // message ("stop") can be recovered by guessing.
    if (!logHashKey || logHashKey.length < 32) {
      throw new Error(
        'TS_LOG_HASH_KEY (at least 32 characters) is required with TYPESAFE_API_KEY'
      );
    }
  }
  return {
    ...DEFAULT_CONFIG,
    model,
    enabled,
    accounts,
    logHashKey,
    shadow: bool(env.TS_SHADOW, false, 'TS_SHADOW'),
    shadowOverride: Object.fromEntries(
      CHECK_NAMES.filter(
        (c) => str(env[`TS_SHADOW_${c.toUpperCase()}`]) !== undefined
      ).map((c) => [
        c,
        bool(
          env[`TS_SHADOW_${c.toUpperCase()}`],
          true,
          `TS_SHADOW_${c.toUpperCase()}`
        ),
      ])
    ) as Partial<Record<CheckName, boolean>>,
    shadowLanguages: parseLanguages(env.TS_SHADOW_LANGUAGES),
    timeoutMs: int(
      env.TS_TIMEOUT_MS,
      DEFAULT_CONFIG.timeoutMs,
      'TS_TIMEOUT_MS',
      MAX_TIMEOUT_MS
    ),
    guardrailTimeoutMs: int(
      env.TS_GUARDRAIL_TIMEOUT_MS,
      DEFAULT_CONFIG.guardrailTimeoutMs,
      'TS_GUARDRAIL_TIMEOUT_MS',
      MAX_TIMEOUT_MS
    ),
    guardrailFailMode: failMode,
  };
}
