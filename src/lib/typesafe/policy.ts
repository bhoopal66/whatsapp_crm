/**
 * Threshold policy (spec §7). Every check runs on the built-in thresholds
 * unless the account has an approved custom policy (two admins, enforced
 * in SQL) for the pinned model and question set. Whether a check acts at
 * all is the account's mode (Settings → AI safety checks), not the
 * thresholds'.
 */
import {
  SWITCHES_OFF,
  SWITCHES_UNKNOWN,
  SWITCHES_UNMANAGED,
  type AccountSwitches,
  type CheckName,
  type Ts013Config,
} from './config';
import type { TsStore } from './store';
import { QS_VERSION, TRIAGE_QUESTIONS } from './questions/triage';
import { GUARDRAIL_QUESTIONS } from './questions/guardrail';

export interface TriageThresholds {
  intentConfidenceMin: number; // below, with a possible complaint → RM (TRIAGE_UNCERTAIN)
  possibleComplaintMin: number; // complaint probability at/above makes low confidence matter
  wantsHumanMin: number; // at/above → RM
  complaintConfidenceMin: number; // complaint intent at/above → RM
  instructsAssistantMin: number; // at/above → restricted bot mode
  nonPartnerBankMin: number; // at/above → non-partner redirect flag
  dissatisfiedMin: number; // at/above → flag on lead
  leadTemperatureMin: number; // score at/above → callback task
  leadTemperatureConfMin: number;
  urgencyHighMin: number; // score at/above → high priority
  urgencyUrgentMin: number; // score at/above → urgent priority
  optOutRecordMin: number; // at/above → record opt-out
  optOutReviewMin: number; // at/above (and below record) → suppress + review
}

export interface GuardrailThresholds {
  actionMin: number; // Noul at/above → that hazard's action
  reviewMin: number; // Noul at/above → hold for RM
  severityBlock: number; // severity at/above upgrades hold → block
}

export interface PassageThresholds {
  injectionMax: number;
  contradictsMin: number;
  relevantMin: number;
  evidenceMin: number;
  fallbackTopK: number;
}

export interface EligibilityThresholds {
  choiceConfidenceMin: number;
}

export interface ThresholdsByCheck {
  triage: TriageThresholds;
  guardrail: GuardrailThresholds;
  passages: PassageThresholds;
  eligibility: EligibilityThresholds;
}

export const DEFAULT_THRESHOLDS: ThresholdsByCheck = {
  triage: {
    intentConfidenceMin: 0.5,
    possibleComplaintMin: 0.25,
    wantsHumanMin: 0.7,
    complaintConfidenceMin: 0.5,
    instructsAssistantMin: 0.7,
    nonPartnerBankMin: 0.7,
    dissatisfiedMin: 0.7,
    leadTemperatureMin: 2.0,
    leadTemperatureConfMin: 0.5,
    urgencyHighMin: 1.0,
    urgencyUrgentMin: 1.6,
    optOutRecordMin: 0.8,
    optOutReviewMin: 0.4,
  },
  guardrail: { actionMin: 0.7, reviewMin: 0.35, severityBlock: 2.0 },
  passages: {
    injectionMax: 0.7,
    contradictsMin: 0.7,
    relevantMin: 0.45,
    evidenceMin: 0.55,
    fallbackTopK: 3,
  },
  eligibility: {
    choiceConfidenceMin: 0.6,
  },
};

/** Highest expected value of a Score: its level count minus one. */
const scoreMax = (q: { criteria: readonly unknown[] }) => q.criteria.length - 1;

/**
 * Allowed range of every threshold, per check. Probabilities and
 * confidences are 0..1; a Score threshold is bounded by that Score's own
 * level count (urgency has 3 levels, so 0..2); fallbackTopK is a count.
 * `ts_validate_thresholds` in migration 063 mirrors this table — change
 * one, change both (policy.test.ts compares them).
 */
export const THRESHOLD_BOUNDS: {
  [C in CheckName]: Record<
    keyof ThresholdsByCheck[C],
    { min: number; max: number; integer?: boolean }
  >;
} = {
  triage: {
    intentConfidenceMin: { min: 0, max: 1 },
    possibleComplaintMin: { min: 0, max: 1 },
    wantsHumanMin: { min: 0, max: 1 },
    complaintConfidenceMin: { min: 0, max: 1 },
    instructsAssistantMin: { min: 0, max: 1 },
    nonPartnerBankMin: { min: 0, max: 1 },
    dissatisfiedMin: { min: 0, max: 1 },
    leadTemperatureMin: {
      min: 0,
      max: scoreMax(TRIAGE_QUESTIONS.lead_temperature),
    },
    leadTemperatureConfMin: { min: 0, max: 1 },
    urgencyHighMin: { min: 0, max: scoreMax(TRIAGE_QUESTIONS.urgency) },
    urgencyUrgentMin: { min: 0, max: scoreMax(TRIAGE_QUESTIONS.urgency) },
    optOutRecordMin: { min: 0, max: 1 },
    optOutReviewMin: { min: 0, max: 1 },
  },
  guardrail: {
    actionMin: { min: 0, max: 1 },
    reviewMin: { min: 0, max: 1 },
    severityBlock: { min: 0, max: scoreMax(GUARDRAIL_QUESTIONS.severity) },
  },
  passages: {
    injectionMax: { min: 0, max: 1 },
    contradictsMin: { min: 0, max: 1 },
    relevantMin: { min: 0, max: 1 },
    evidenceMin: { min: 0, max: 1 },
    fallbackTopK: { min: 0, max: 20, integer: true },
  },
  eligibility: {
    choiceConfidenceMin: { min: 0, max: 1 },
  },
};

export interface ResolvedPolicy<C extends CheckName = CheckName> {
  check: C;
  /** null = built-in defaults */
  version: number | null;
  modelId: string;
  questionSetVersion: string;
  thresholds: ThresholdsByCheck[C];
  /** Effective shadow for this policy (config, policy flag, or mismatch). */
  shadow: boolean;
  shadowReasons: string[];
  /** true when the active policy could not be loaded or validated and no earlier good copy exists. */
  loadError: boolean;
}

/** Validates a thresholds object: exactly the known keys, finite numbers in range. */
export function validateThresholds<C extends CheckName>(
  check: C,
  raw: unknown
): ThresholdsByCheck[C] {
  const bounds = THRESHOLD_BOUNDS[check] as Record<
    string,
    { min: number; max: number; integer?: boolean }
  >;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${check}: thresholds must be an object`);
  const obj = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, b] of Object.entries(bounds)) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new Error(`${check}.${key}: missing or not a number`);
    if (v < b.min || v > b.max || (b.integer && !Number.isInteger(v))) {
      throw new Error(`${check}.${key}: ${v} out of range`);
    }
    out[key] = v;
  }
  const extra = Object.keys(obj).filter(
    (k) => !Object.prototype.hasOwnProperty.call(bounds, k)
  );
  if (extra.length)
    throw new Error(`${check}: unknown threshold keys ${extra.join(', ')}`);
  if (check === 'triage' && out.optOutReviewMin! > out.optOutRecordMin!)
    throw new Error('triage: optOutReviewMin > optOutRecordMin');
  if (check === 'triage' && out.urgencyHighMin! > out.urgencyUrgentMin!)
    throw new Error('triage: urgencyHighMin > urgencyUrgentMin');
  if (check === 'guardrail' && out.reviewMin! > out.actionMin!)
    throw new Error('guardrail: reviewMin > actionMin');
  return out as unknown as ThresholdsByCheck[C];
}

export function defaultPolicy<C extends CheckName>(
  check: C,
  config: Ts013Config
): ResolvedPolicy<C> {
  return {
    check,
    version: null,
    modelId: config.model,
    questionSetVersion: QS_VERSION,
    thresholds: DEFAULT_THRESHOLDS[check],
    shadow: false,
    shadowReasons: [],
    loadError: false,
  };
}

/**
 * Loads each account's active approved policy per check, cached for ttlMs.
 *  - No policy: the built-in thresholds.
 *  - A policy approved as shadow (`ts_policy.shadow`) keeps that check
 *    logged-only for the account.
 *  - A policy for another model or question set, or with invalid
 *    thresholds, is ignored in favour of the built-in thresholds, with an
 *    alert — the same in every process. (SQL validates at approval, so an
 *    invalid one needs a hand-edited row.)
 *  - A read error is retried once at once; if it persists, keep the last
 *    good policy if there is one, otherwise the built-in thresholds with
 *    loadError=true. Errors are cached only briefly (errorTtlMs).
 */
export class PolicyStore {
  private cache = new Map<
    string,
    { at: number; ttl: number; policy: ResolvedPolicy }
  >();
  private lastGood = new Map<string, ResolvedPolicy>();

  constructor(
    private readonly deps: {
      store?: TsStore;
      config: Ts013Config;
      ttlMs?: number;
      errorTtlMs?: number;
      now?: () => number;
      onError?: (
        check: CheckName,
        err: unknown,
        kind: 'load' | 'invalid' | 'mismatch'
      ) => void;
    }
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  async get<C extends CheckName>(
    check: C,
    accountId: string
  ): Promise<ResolvedPolicy<C>> {
    const key = `${accountId}:${check}`;
    const now = (this.deps.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < hit.ttl) return hit.policy as ResolvedPolicy<C>;

    const { config } = this.deps;
    let policy: ResolvedPolicy<C> = defaultPolicy(check, config);
    let failed = false;
    const store = this.deps.store;
    if (store) {
      let row: Awaited<ReturnType<TsStore['activePolicy']>> = null;
      try {
        row = await store
          .activePolicy(accountId, check)
          .catch(() => store.activePolicy(accountId, check));
      } catch (err) {
        failed = true;
        this.deps.onError?.(check, err, 'load');
        const good = this.lastGood.get(key) as ResolvedPolicy<C> | undefined;
        policy = good ?? { ...defaultPolicy(check, config), loadError: true };
      }
      if (row) {
        if (
          row.model_id !== config.model ||
          row.question_set_version !== QS_VERSION
        ) {
          this.deps.onError?.(
            check,
            new Error(
              `approved policy v${row.version} is for ${row.model_id} / ${row.question_set_version}; running ${config.model} / ${QS_VERSION} — using the built-in thresholds`
            ),
            'mismatch'
          );
        } else {
          try {
            policy = {
              check,
              version: row.version,
              modelId: row.model_id,
              questionSetVersion: row.question_set_version,
              thresholds: validateThresholds(check, row.thresholds),
              shadow: row.shadow,
              shadowReasons: row.shadow ? ['POLICY_SHADOW'] : [],
              loadError: false,
            };
          } catch (err) {
            this.deps.onError?.(check, err, 'invalid');
          }
        }
      }
    }
    if (!failed) this.lastGood.set(key, policy);
    this.cache.set(key, {
      at: now,
      ttl: failed
        ? (this.deps.errorTtlMs ?? 5_000)
        : (this.deps.ttlMs ?? 60_000),
      policy,
    });
    return policy;
  }
}

/**
 * Each account's own switches (migration 064), cached for ttlMs (30 s by
 * default). No row means off. A read error keeps the last switches read;
 * with none, the result is SWITCHES_UNKNOWN (off, but the guardrail
 * holds). A store without `accountSwitches` (tests, the evaluation
 * harness) leaves the install configuration to decide.
 *
 * `set` is how the settings API applies a save in this process at once:
 * it replaces the cached and last-good copy, and a read that started
 * before the save cannot overwrite it afterwards (the generation check).
 */
export class SwitchesStore {
  private cache = new Map<
    string,
    { at: number; ttl: number; sw: AccountSwitches }
  >();
  private lastGood = new Map<string, AccountSwitches>();
  private generation = new Map<string, number>();

  constructor(
    private readonly deps: {
      store?: TsStore;
      ttlMs?: number;
      errorTtlMs?: number;
      now?: () => number;
      onError?: (err: unknown) => void;
    }
  ) {}

  private bump(accountId: string): void {
    this.generation.set(accountId, (this.generation.get(accountId) ?? 0) + 1);
  }

  invalidate(accountId?: string): void {
    if (accountId) {
      this.cache.delete(accountId);
      this.bump(accountId);
    } else {
      this.cache.clear();
      for (const id of this.generation.keys()) this.bump(id);
    }
  }

  /** The account's switches as just saved: applied here at once. */
  set(accountId: string, sw: AccountSwitches): void {
    this.bump(accountId);
    this.lastGood.set(accountId, sw);
    this.cache.set(accountId, {
      at: (this.deps.now ?? Date.now)(),
      ttl: this.deps.ttlMs ?? 30_000,
      sw,
    });
  }

  async get(accountId: string): Promise<AccountSwitches> {
    const read = this.deps.store?.accountSwitches?.bind(this.deps.store);
    if (!read) return SWITCHES_UNMANAGED;
    const now = (this.deps.now ?? Date.now)();
    const hit = this.cache.get(accountId);
    if (hit && now - hit.at < hit.ttl) return hit.sw;

    const gen = this.generation.get(accountId) ?? 0;
    let sw: AccountSwitches;
    let failed = false;
    try {
      sw = (await read(accountId).catch(() => read(accountId))) ?? SWITCHES_OFF;
    } catch (err) {
      failed = true;
      this.deps.onError?.(err);
      sw = this.lastGood.get(accountId) ?? SWITCHES_UNKNOWN;
    }
    // Saved or invalidated while this read was in flight: the read may
    // predate the save, so the newer state wins and nothing is cached.
    if ((this.generation.get(accountId) ?? 0) !== gen) {
      const newer = this.cache.get(accountId);
      return newer ? newer.sw : sw;
    }
    if (!failed) this.lastGood.set(accountId, sw);
    this.cache.set(accountId, {
      at: now,
      ttl: failed
        ? (this.deps.errorTtlMs ?? 5_000)
        : (this.deps.ttlMs ?? 30_000),
      sw,
    });
    return sw;
  }
}
