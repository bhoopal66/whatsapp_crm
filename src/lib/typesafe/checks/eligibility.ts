/**
 * Check E — pre-eligibility capture. Hook 4: the bot's pre-eligibility step.
 * Output feeds the EXISTING appetite-matrix code unchanged. Indication only —
 * not a credit decision (spec §2.2).
 */
import { detectLanguage } from '../redact';
import {
  buildEligibilityQuestions,
  extractAmountCandidates,
  extractYearsCandidates,
  EMIRATES,
  LEGAL_FORMS,
  TRADE_LICENCE,
  type Candidate,
  type EligibilityState,
} from '../questions/eligibility';
import { QS_VERSION } from '../questions/triage';
import {
  redactClipped,
  type CheckDeps,
  type DecisionMeta,
  type Ref,
  stateFor,
} from './common';
import { refOf } from './triage';

export interface Field<T> {
  value: T | null;
  confidence: number | null;
  /** true → the bot must ask the customer for this field; never guess. */
  reask: boolean;
}

export interface TurnoverBand {
  label: string;
  minAed: number;
  maxAed: number | null;
}

export const DEFAULT_TURNOVER_BANDS: TurnoverBand[] = [
  { label: 'below AED 1m', minAed: 0, maxAed: 1_000_000 },
  { label: 'AED 1m–3m', minAed: 1_000_000, maxAed: 3_000_000 },
  { label: 'AED 3m–10m', minAed: 3_000_000, maxAed: 10_000_000 },
  { label: 'AED 10m–50m', minAed: 10_000_000, maxAed: 50_000_000 },
  { label: 'AED 50m and above', minAed: 50_000_000, maxAed: null },
];

export const bandFor = (
  aed: number,
  bands: TurnoverBand[] = DEFAULT_TURNOVER_BANDS
): string | null =>
  bands.find((b) => aed >= b.minAed && (b.maxAed === null || aed < b.maxAed))
    ?.label ?? null;

export interface EligibilityInput extends Ref {
  conversation: { from: 'customer' | 'taamul'; text: string }[];
  /** Sector keys → descriptions, loaded from the appetite-matrix table at runtime. */
  sectors: Record<string, string>;
  turnoverBands?: TurnoverBand[];
  currentYear?: number;
}

export interface EligibilityDecision extends DecisionMeta {
  emirate: Field<keyof typeof EMIRATES>;
  legalForm: Field<keyof typeof LEGAL_FORMS>;
  sector: Field<string>;
  turnover: Field<{ aed: number; band: string | null }>;
  yearsInBusiness: Field<number>;
  hasTradeLicence: Field<boolean>;
}

const empty = <T>(): Field<T> => ({
  value: null,
  confidence: null,
  reask: true,
});
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 1000;

export async function runEligibility(
  deps: CheckDeps,
  input: EligibilityInput
): Promise<EligibilityDecision> {
  const year =
    input.currentYear ?? (deps.now ? deps.now() : new Date()).getFullYear();

  const allEmpty = {
    emirate: empty<keyof typeof EMIRATES>(),
    legalForm: empty<keyof typeof LEGAL_FORMS>(),
    sector: empty<string>(),
    turnover: empty<{ aed: number; band: string | null }>(),
    yearsInBusiness: empty<number>(),
    hasTradeLicence: empty<boolean>(),
  };
  // Off for this account (or on this install): no policy read, no
  // request, no log.
  const cs = await stateFor(deps, 'eligibility', input.accountId);
  if (!cs.on) {
    return {
      policyVersion: null,
      shadowReasons: ['DISABLED'],
      ...allEmpty,
      act: false,
      shadow: true,
      fallbackUsed: false,
      errorCode: 'DISABLED',
      reasonCodes: [],
      modelId: null,
      decisionId: null,
      latencyMs: 0,
    };
  }

  const policy = await deps.policies.get('eligibility', input.accountId);
  const t = policy.thresholds;
  const meta = {
    policyVersion: policy.version,
    shadowReasons: policy.shadowReasons,
  };
  const convo = input.conversation.slice(-MAX_MESSAGES).map((m, i) => ({
    n: i + 1,
    from: m.from,
    text: redactClipped(m.text, MAX_MESSAGE_CHARS),
  }));
  const customer = convo
    .filter((m) => m.from === 'customer')
    .map((m) => ({ n: m.n, text: m.text }));
  const turnoverCands = extractAmountCandidates(customer);
  const yearsCands = extractYearsCandidates(customer, year);

  // Host sector keys may collide with our reserved options; map them, and map back on the way out.
  const RESERVED = new Set(['other', 'not_stated']);
  const toInternal = new Map<string, string>();
  const toHost = new Map<string, string>();
  for (const k of Object.keys(input.sectors)) {
    let ik = RESERVED.has(k) ? `${k}_sector` : k;
    while (toHost.has(ik) || RESERVED.has(ik)) ik = `${ik}_`;
    toInternal.set(k, ik);
    toHost.set(ik, k);
  }
  const sectorCount = toInternal.size;
  const askSector = sectorCount > 0 && sectorCount <= 253;
  if (!askSector) {
    deps.alert({
      level: 'warn',
      code: 'ELIGIBILITY_SECTORS',
      check: 'eligibility',
      message: `Sector list has ${sectorCount} entries (allowed 1–253); sector will be re-asked.`,
    });
  }
  const internalSectors = askSector
    ? Object.fromEntries(
        [...toInternal].map(([k, ik]) => [ik, input.sectors[k]!])
      )
    : { placeholder: 'unused' };

  const all = buildEligibilityQuestions({
    sectors: internalSectors,
    turnover: turnoverCands,
    years: yearsCands,
  });
  // Don't ask a Choice whose only option is "none" — the answer is already known.
  const { turnover_candidate, years_candidate, sector, ...rest } = all;
  const questions = {
    ...rest,
    ...(askSector ? { sector } : {}),
    ...(turnoverCands.length ? { turnover_candidate } : {}),
    ...(yearsCands.length ? { years_candidate } : {}),
  };

  const state: EligibilityState = { conversation: convo };
  const res = await deps.gateway.ask(
    'eligibility',
    state,
    questions,
    input.accountId
  );

  if (!res.ok) {
    const decisionId = await deps.logger.write({
      check: 'eligibility',
      ...refOf(input),
      policyVersion: policy.version,
      modelId: null,
      questionSetVersion: QS_VERSION,
      language: detectLanguage(customer.map((m) => m.text).join(' ')),
      redactedState: state,
      answers: null,
      decision: 'reask_all',
      reasonCodes: ['FALLBACK'],
      acted: false,
      shadow: policy.shadow || cs.monitor,
      fallbackUsed: true,
      latencyMs: res.latencyMs,
      inputTokens: null,
      errorCode: res.errorCode,
    });
    return {
      ...meta,
      ...allEmpty,
      act: false,
      shadow: policy.shadow || cs.monitor,
      fallbackUsed: true,
      errorCode: res.errorCode,
      reasonCodes: ['FALLBACK'],
      modelId: null,
      decisionId,
      latencyMs: res.latencyMs,
    };
  }

  const a = res.result.answers as Record<
    string,
    { choice?: string; confidence?: number; noul?: number }
  >;
  const pick = <K extends string>(q: string, notStated: string[]): Field<K> => {
    const ans = a[q];
    if (!ans || ans.choice === undefined) return empty<K>();
    const conf = ans.confidence ?? 0;
    const ok = conf >= t.choiceConfidenceMin && !notStated.includes(ans.choice);
    return {
      value: ok ? (ans.choice as K) : null,
      confidence: conf,
      reask: !ok,
    };
  };
  const fromCandidate = (
    q: string,
    cands: Candidate[],
    none: string
  ): Field<number> => {
    const f = pick<string>(q, [none]);
    if (f.value === null)
      return { value: null, confidence: f.confidence, reask: true };
    const c = cands.find((x) => x.key === f.value);
    return c
      ? { value: c.value, confidence: f.confidence, reask: false }
      : { value: null, confidence: f.confidence, reask: true };
  };

  const turnoverNum = fromCandidate(
    'turnover_candidate',
    turnoverCands,
    'none_is_turnover'
  );
  const lic = pick<keyof typeof TRADE_LICENCE>('trade_licence', ['not_stated']);
  const decision: Omit<EligibilityDecision, keyof DecisionMeta> = {
    emirate: pick('emirate', ['not_stated']),
    legalForm: pick('legal_form', ['not_stated']),
    sector: (() => {
      const f = pick<string>('sector', ['not_stated']);
      if (f.value === null) return f;
      // Our "fits none of the listed sectors" answer is not a host sector: re-ask.
      if (f.value === 'other')
        return { value: null, confidence: f.confidence, reask: true };
      const host = toHost.get(f.value);
      return host === undefined
        ? { value: null, confidence: f.confidence, reask: true }
        : { ...f, value: host };
    })(),
    turnover:
      turnoverNum.value === null
        ? { value: null, confidence: turnoverNum.confidence, reask: true }
        : {
            value: {
              aed: turnoverNum.value,
              band: bandFor(turnoverNum.value, input.turnoverBands),
            },
            confidence: turnoverNum.confidence,
            reask: false,
          },
    yearsInBusiness: fromCandidate(
      'years_candidate',
      yearsCands,
      'none_is_years_in_business'
    ),
    hasTradeLicence:
      lic.value === null
        ? { value: null, confidence: lic.confidence, reask: true }
        : {
            value: lic.value === 'holds_licence',
            confidence: lic.confidence,
            reask: false,
          },
  };

  const reask = (Object.entries(decision) as [string, Field<unknown>][])
    .filter(([, f]) => f.reask)
    .map(([k]) => `REASK_${k}`);
  const lang = detectLanguage(
    input.conversation
      .filter((m) => m.from === 'customer')
      .map((m) => m.text)
      .join(' ')
  );
  const langShadow = cs.shadowLanguages.includes(lang);
  const shadow = cs.monitor || policy.shadow || res.modelMismatch || langShadow;
  const shadowReasons = [
    ...policy.shadowReasons,
    ...(cs.monitor ? ['MONITOR'] : []),
    ...(res.modelMismatch ? ['RESPONSE_MODEL_MISMATCH'] : []),
    ...(langShadow ? [`LANGUAGE_SHADOW:${lang}`] : []),
  ];
  const act = !shadow;

  const decisionId = await deps.logger.write({
    check: 'eligibility',
    ...refOf(input),
    policyVersion: policy.version,
    modelId: res.result.model,
    questionSetVersion: QS_VERSION,
    language: detectLanguage(customer.map((m) => m.text).join(' ')),
    redactedState: state,
    // Candidate snippets contain customer text: log only key, value and message number.
    answers: {
      ...res.result.answers,
      candidates: {
        turnover: turnoverCands.map(({ key, value, messageNo }) => ({
          key,
          value,
          messageNo,
        })),
        years: yearsCands.map(({ key, value, messageNo }) => ({
          key,
          value,
          messageNo,
        })),
      },
    },
    decision: reask.length ? `partial:${6 - reask.length}/6` : 'complete',
    reasonCodes: reask,
    acted: act,
    shadow,
    fallbackUsed: false,
    latencyMs: res.latencyMs,
    inputTokens: res.result.usage.input_tokens,
    errorCode: null,
  });

  return {
    ...decision,
    act,
    shadow,
    shadowReasons: [...new Set(shadowReasons)],
    fallbackUsed: false,
    errorCode: null,
    reasonCodes: reask,
    policyVersion: policy.version,
    modelId: res.result.model,
    decisionId,
    latencyMs: res.latencyMs,
  };
}
