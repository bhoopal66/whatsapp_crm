/**
 * TypeSafe decision layer (module 013, migration 063). Public entry point.
 *
 *   const ts = getDecisionLayer();
 *   const d = await ts.triage({ accountId, message, journeyStage, contactId });
 *   if (d.act) { ...apply d.route / d.optOut / d.rmTask... } else { ...today's behaviour... }
 *
 * HOST RULE for every check: `act === false` → ignore the decision.
 * The one host today is `lib/ai/auto-reply.ts`; docs/typesafe.md is the
 * operator-facing contract.
 */
import type { Fetch } from '@typesafe-ai/sdk';
import { TypeSafeGateway, type AlertSink } from './client';
import {
  CHECK_NAMES,
  checkState,
  loadConfig,
  type CheckName,
  type CheckState,
  type Ts013Config,
} from './config';
import { DecisionLogger } from './log';
import { supabaseStore, type TsStore } from './store';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { PolicyStore, SwitchesStore } from './policy';
import { partnerCatalogue, type PartnerCatalogue } from './banks';
import { runEligibility, type EligibilityInput } from './checks/eligibility';
import { runGuardrail, type GuardrailInput } from './checks/guardrail';
import { runPassageFilter, type RetrievedPassage } from './checks/passages';
import { runTriage, type TriageInput } from './checks/triage';
import { runRoute, type RouteInput } from './checks/route';
import { runKbSelect, type KbSelectInput } from './checks/kb-select';
import type { CheckDeps, Ref } from './checks/common';

export interface DecisionLayerOptions {
  /** Service-role policy/log store. Omit to run without logging or DB policies. */
  store?: TsStore;
  config?: Ts013Config;
  alert?: AlertSink;
  apiKey?: string;
  fetch?: Fetch;
  now?: () => Date;
  /** HMAC key for the log's state and message hashes. Defaults to TS_LOG_HASH_KEY. */
  logHashKey?: string;
}

/** How long an alert code stays quiet after it has been printed once. */
const ALERT_QUIET_MS = 5 * 60_000;

/**
 * The default alert sink: the server log, deduplicated per (code, check)
 * so an outage or a policy-read error prints once per five minutes with a
 * count, instead of once per message. Messages carry codes, statuses and
 * request ids only — never customer text or response bodies.
 */
export function consoleAlertSink(now: () => number = Date.now): AlertSink {
  const last = new Map<string, { at: number; suppressed: number }>();
  return (e) => {
    const key = `${e.code}:${e.check ?? ''}`;
    const t = now();
    const seen = last.get(key);
    if (seen && t - seen.at < ALERT_QUIET_MS) {
      seen.suppressed++;
      return;
    }
    const extra = seen?.suppressed
      ? ` (+${seen.suppressed} more in the last ${Math.round((t - seen.at) / 60_000)} min)`
      : '';
    last.set(key, { at: t, suppressed: 0 });
    const line = `[ts013] ${e.level} ${e.code}${e.check ? ` (${e.check})` : ''}: ${e.message}${extra}`;
    if (e.level === 'error') console.error(line);
    else console.warn(line);
  };
}

export function createDecisionLayer(opts: DecisionLayerOptions = {}) {
  const config = opts.config ?? loadConfig();
  const alert: AlertSink = opts.alert ?? consoleAlertSink();
  const gateway = new TypeSafeGateway({
    config,
    alert,
    apiKey: opts.apiKey,
    fetch: opts.fetch,
  });
  const policies = new PolicyStore({
    store: opts.store,
    config,
    onError: (check, err, kind) =>
      alert({
        level: 'error',
        code:
          kind === 'invalid'
            ? 'POLICY_INVALID'
            : kind === 'mismatch'
              ? 'POLICY_MISMATCH'
              : 'POLICY_LOAD',
        check,
        message:
          kind === 'load'
            ? `Policy load failed; keeping the last policy read, else the built-in thresholds. ${err instanceof Error ? err.message : 'error'}`
            : `The approved custom policy is ignored; the built-in thresholds apply until a valid one is approved. ${err instanceof Error ? err.message : 'error'}`,
      }),
  });
  const switches = new SwitchesStore({
    store: opts.store,
    onError: (err) =>
      alert({
        level: 'error',
        code: 'SETTINGS_LOAD',
        message: `Account settings could not be read; keeping the last read, else off. ${err instanceof Error ? err.message : 'error'}`,
      }),
  });
  const hashKey =
    opts.logHashKey ?? config.logHashKey ?? process.env.TS_LOG_HASH_KEY;
  if (opts.store && !hashKey && CHECK_NAMES.some((c) => config.enabled[c])) {
    alert({
      level: 'warn',
      code: 'LOG_HASH_KEY',
      message: 'TS_LOG_HASH_KEY not set; state_hash uses plain SHA-256.',
    });
  }
  const logger = new DecisionLogger(
    opts.store,
    (err, rec) =>
      alert({
        level: 'error',
        code: 'LOG_WRITE',
        check: rec.check,
        message: `Decision log write failed: ${err instanceof Error ? err.message : 'error'}`,
      }),
    hashKey
  );
  const deps: CheckDeps = {
    config,
    gateway,
    policies,
    switches,
    logger,
    alert,
    now: opts.now,
  };

  /** The account's partner banks, from its cached settings row (30 s;
   *  a settings save applies at once). Built-in list when none saved. */
  const partners = async (accountId: string): Promise<PartnerCatalogue> =>
    partnerCatalogue((await switches.get(accountId)).partnerBanks ?? null);

  return {
    config,
    gateway,
    policies,
    switches,
    /** Whether `check` runs, and acts, for this account right now. */
    state: async (check: CheckName, accountId: string): Promise<CheckState> =>
      checkState(config, await switches.get(accountId), check, accountId),
    partners,
    triage: async (input: TriageInput) =>
      runTriage(deps, {
        ...input,
        partners: input.partners ?? (await partners(input.accountId)),
      }),
    guardrail: async (input: GuardrailInput) =>
      runGuardrail(deps, {
        ...input,
        partners: input.partners ?? (await partners(input.accountId)),
      }),
    passages: (input: Ref & { query: string; passages: RetrievedPassage[] }) =>
      runPassageFilter(deps, input),
    eligibility: (input: EligibilityInput) => runEligibility(deps, input),
    /**
     * Model-tier routing judgment (lib/ai/router.ts). Not a safety
     * check: no account switch, no policy, no log row. Never throws.
     */
    route: (input: RouteInput) => runRoute({ config, gateway }, input),
    /**
     * Approved-answers selection (module 017). Not a safety check: no
     * account switch, no policy, no log row. Never throws.
     */
    kbSelect: (input: KbSelectInput) => runKbSelect({ config, gateway }, input),
  };
}

export type DecisionLayer = ReturnType<typeof createDecisionLayer>;

let shared: DecisionLayer | null = null;
let configError: { message: string; loggedAt: number } | null = null;

/**
 * The process-wide layer over the service-role client, or null when the
 * TS_* configuration is invalid. One instance per process on purpose: the
 * circuit breakers, pauses and policy cache are its state.
 *
 * An unreadable configuration turns the layer OFF — every gate passes
 * through and the bot behaves as it did before module 013 — and says so
 * in the server log at boot (src/instrumentation.ts) and at most once a
 * minute after that. The alternative, throwing, silenced the bot on every
 * account over one typo in a variable nobody meant to use.
 */
export function getDecisionLayer(): DecisionLayer | null {
  if (shared) return shared;
  try {
    shared = createDecisionLayer({ store: supabaseStore(supabaseAdmin()) });
    return shared;
  } catch (err) {
    const now = Date.now();
    const message = err instanceof Error ? err.message : String(err);
    if (!configError || now - configError.loggedAt >= 60_000) {
      console.error(
        `[ts013] error CONFIG_INVALID: the TypeSafe layer is OFF until this is fixed and the service restarted — ${message}`
      );
      configError = { message, loggedAt: now };
    }
    return null;
  }
}

export { loadConfig, DEFAULT_CONFIG } from './config';
export type { Ts013Config, CheckName, GuardrailFailMode } from './config';
export {
  redact,
  redactDeep,
  containsRawIdentifier,
  detectLanguage,
} from './redact';
export {
  detectBanks,
  detectBanksIn,
  partnerCatalogue,
  BANKS,
  PARTNER_BANK_DISPLAY,
  type PartnerCatalogue,
} from './banks';
export { DEFAULT_THRESHOLDS, validateThresholds } from './policy';
export { routeTriage } from './checks/triage';
export {
  routeGuardrail,
  unsupportedFigures,
  extractFigures,
} from './checks/guardrail';
export { routePassage } from './checks/passages';
export { bandFor, DEFAULT_TURNOVER_BANDS } from './checks/eligibility';
export { QS_VERSION } from './questions/triage';
export { ROUTE_QS_VERSION, type RouteKind } from './questions/route';
export type { RouteInput, RouteJudgment } from './checks/route';
export { KB_SELECT_QS_VERSION } from './questions/kb-select';
export type { KbSelectInput, KbSelectJudgment } from './checks/kb-select';
export type { TriageDecision, TriageInput } from './checks/triage';
export type { GuardrailDecision, GuardrailInput } from './checks/guardrail';
export type { PassageDecision, RetrievedPassage } from './checks/passages';
export type {
  EligibilityDecision,
  EligibilityInput,
} from './checks/eligibility';
export type { TsStore } from './store';
export type { AlertSink } from './client';
