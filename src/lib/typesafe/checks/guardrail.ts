/**
 * Check C — bot reply guardrail. Hook 3: call immediately before the WhatsApp
 * send of any free-text bot reply.
 *
 * Deterministic checks run first and still apply when TypeSafe is down, and
 * while the reply's language is still in shadow for the model:
 *   - non-partner bank named in the reply (dictionary)  → block
 *     (hold when the customer named that bank first — the reply is most
 *     likely declining it, which a person should confirm)
 *   - % / AED figure in the reply found in no sanctioned source → hold
 *     (sources: the knowledge excerpts and the business's own context —
 *     never the customer's text, or a customer could assert a rate and
 *     have the bot confirm it; an echoed figure goes to a person)
 */
import {
  detectBanksIn,
  partnerCatalogue,
  type PartnerCatalogue,
} from '../banks';
import type { GuardrailThresholds } from '../policy';
import { detectLanguage, normaliseDigits } from '../redact';
import {
  GUARDRAIL_NOUL_ACTION,
  GUARDRAIL_QUESTIONS,
  type GuardrailHazard,
  type GuardrailState,
} from '../questions/guardrail';
import { QS_VERSION } from '../questions/triage';
import {
  redactClipped,
  clip,
  type CheckDeps,
  type DecisionMeta,
  type Ref,
  stateFor,
} from './common';
import { refOf } from './triage';

export type GuardrailOutcome = 'send' | 'hold' | 'block';

export interface GuardrailInput extends Ref {
  customerMessage: string;
  botReply: string;
  /** Knowledge excerpts the prompt was built from. Ids stay local: the
   *  state carries ordinals, never database ids. */
  evidence: { id: string; text: string }[];
  /**
   * Other text the bot was given as a source of facts: the business's own
   * instructions, the campaign message the customer is answering, the
   * guided-flow step. A figure or claim found there is not "unsupported".
   */
  context?: string[];
  /** The account's bank dictionary (DecisionLayer.partners). Absent: the
   *  built-in partner list. */
  partners?: PartnerCatalogue;
}

export interface GuardrailDecision extends DecisionMeta {
  /** send = send botReply; hold = do not send, put draft in RM inbox (GUARDRAIL_REVIEW);
   *  block = do not send, send holding template, RM task GUARDRAIL_BLOCK with draft attached. */
  outcome: GuardrailOutcome;
  hazards: {
    hazard: GuardrailHazard | 'severity';
    value: number;
    source: 'model' | 'code';
  }[];
  rmTaskReason:
    'GUARDRAIL_BLOCK' | 'GUARDRAIL_REVIEW' | 'GUARDRAIL_UNAVAILABLE' | null;
}

const RANK: Record<GuardrailOutcome, number> = { send: 0, hold: 1, block: 2 };
const worst = (a: GuardrailOutcome, b: GuardrailOutcome): GuardrailOutcome =>
  RANK[a] >= RANK[b] ? a : b;

/**
 * Figures (percentages and AED amounts) as canonical keys "3.5%" / "AED25000",
 * compared numerically (3.50% == 3.5%, AED 25k == AED 25,000).
 */
export function extractFigures(text: string): string[] {
  const t = normaliseDigits(text);
  const out = new Set<string>();
  // Left-anchored: a number starts where no digit, comma or point is
  // before it. Without the anchor every position inside a long digit run
  // is a new start, and matching goes quadratic (a customer-typed run of
  // 65k digits blocked the event loop for tens of seconds).
  const NUM = String.raw`(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
  // Next to a currency word, space-grouped thousands ("AED 25 000",
  // "750 000 AED") are one amount; elsewhere a space separates numbers.
  const NUM_CUR = String.raw`(?<![\d,.])(\d{1,3}(?:[,\u00a0\u202f ]\d{3})+|\d+)(?:\.(\d+))?`;
  const UNIT = String.raw`(k|mn|m|million|thousand|bn|billion|مليون|ألف|الف|مليار)(?![a-z\u0600-\u06FF])`;
  const CUR_PRE = String.raw`(?:aed|dhs?\.?|dirhams?|درهم)`;
  const CUR_POST = String.raw`(?:aed|dhs?\.?|dirhams?|درهم)`;
  const num = (i: string, d?: string) =>
    Number(`${i.replace(/[,\u00a0\u202f ]/g, '')}${d ? `.${d}` : ''}`);
  const round = (v: number) => Math.round(v * 100) / 100;

  for (const m of t.matchAll(
    new RegExp(`${NUM}\\s*(%|٪|per\\s*cent|percent|بالمئة|بالمائة)`, 'gi')
  )) {
    out.add(`${round(num(m[1]!, m[2]))}%`);
  }
  const mult = (u: string | undefined) => {
    const x = (u ?? '').toLowerCase();
    if (/^(k|thousand|ألف|الف)$/.test(x)) return 1e3;
    if (/^(m|mn|million|مليون)$/.test(x)) return 1e6;
    if (/^(bn|billion|مليار)$/.test(x)) return 1e9;
    return 1;
  };
  const pre = new RegExp(`${CUR_PRE}\\s*${NUM_CUR}(?:\\s*${UNIT})?`, 'gi');
  const post = new RegExp(`${NUM_CUR}(?:\\s*${UNIT})?\\s*${CUR_POST}`, 'gi');
  for (const m of t.matchAll(pre))
    out.add(`AED${round(num(m[1]!, m[2]) * mult(m[3]))}`);
  for (const m of t.matchAll(post))
    out.add(`AED${round(num(m[1]!, m[2]) * mult(m[3]))}`);
  return [...out];
}

/** Plain numbers in a text ("Minimum balance: 25,000"), as canonical values. */
function bareNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of normaliseDigits(text).matchAll(
    /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d])/g
  )) {
    const v = Number(`${m[1]!.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    if (Number.isFinite(v)) out.add(Math.round(v * 100) / 100);
  }
  return out;
}

/**
 * Figures in `reply` that no source supports. A source supports a figure
 * when it states the same figure, or — for an AED amount of at least
 * 1,000 — states the bare number ("Minimum balance: 25,000" supports
 * "AED 25,000"). Small bare numbers are days, months and document counts
 * far more often than money: "30 days" must not vouch for "AED 30".
 */
export function unsupportedFigures(
  reply: string,
  sources: { text: string }[]
): string[] {
  const sourceFigures = new Set(sources.flatMap((e) => extractFigures(e.text)));
  const sourceNumbers = new Set(
    sources.flatMap((e) => [...bareNumbers(e.text)])
  );
  return extractFigures(reply).filter((f) => {
    if (sourceFigures.has(f)) return false;
    const v = Number(f.slice(3));
    return !(f.startsWith('AED') && v >= 1000 && sourceNumbers.has(v));
  });
}

export type GuardAnswers = { [K in GuardrailHazard]: { noul: number } } & {
  severity: { score: number };
};

export function routeGuardrail(a: GuardAnswers, t: GuardrailThresholds) {
  let outcome: GuardrailOutcome = 'send';
  const hazards: GuardrailDecision['hazards'] = [];
  const reasons: string[] = [];
  let anyReview = false;
  for (const hazard of Object.keys(
    GUARDRAIL_NOUL_ACTION
  ) as GuardrailHazard[]) {
    const p = a[hazard].noul;
    if (p >= t.actionMin) {
      const action = GUARDRAIL_NOUL_ACTION[hazard];
      outcome = worst(outcome, action === 'block' ? 'block' : 'hold');
      hazards.push({ hazard, value: p, source: 'model' });
      reasons.push(`${hazard.toUpperCase()}_${action.toUpperCase()}`);
      if (action === 'review') anyReview = true;
    } else if (p >= t.reviewMin) {
      outcome = worst(outcome, 'hold');
      hazards.push({ hazard, value: p, source: 'model' });
      reasons.push(`${hazard.toUpperCase()}_REVIEW`);
      anyReview = true;
    }
  }
  if (
    a.severity.score >= t.severityBlock &&
    (outcome === 'hold' || anyReview)
  ) {
    outcome = 'block';
    hazards.push({
      hazard: 'severity',
      value: a.severity.score,
      source: 'model',
    });
    reasons.push('SEVERITY_UPGRADE');
  }
  return { outcome, hazards, reasons };
}

/** Deterministic layer (raw text; nothing leaves the process). Shared with calibration. */
export function codeLayer(
  botReply: string,
  evidence: { text: string }[],
  opts: {
    customerMessage?: string;
    context?: string[];
    partners?: PartnerCatalogue;
  } = {}
) {
  const { banks } = opts.partners ?? partnerCatalogue(null);
  const codeHazards: GuardrailDecision['hazards'] = [];
  const codeReasons: string[] = [];
  let codeOutcome: GuardrailOutcome = 'send';
  const nonPartner = detectBanksIn(botReply, banks).filter((b) => !b.partner);
  if (nonPartner.length) {
    // A bank the customer named first is most likely being declined
    // ("we don't work with ADCB") — a person confirms, nothing is sent.
    const named = new Set(
      detectBanksIn(opts.customerMessage ?? '', banks).map((b) => b.code)
    );
    const echoOnly = nonPartner.every((b) => named.has(b.code));
    codeOutcome = echoOnly ? 'hold' : 'block';
    codeHazards.push({ hazard: 'non_partner_bank', value: 1, source: 'code' });
    codeReasons.push(
      echoOnly ? 'CODE_NON_PARTNER_BANK_ECHO' : 'CODE_NON_PARTNER_BANK'
    );
  }
  // Clipped like the state is: the code layer must not do unbounded work
  // on text a customer can influence.
  const badFigures = unsupportedFigures(clip(botReply, MAX_MESSAGE_CHARS), [
    ...evidence.map((e) => ({ text: clip(e.text, MAX_PASSAGE_CHARS) })),
    ...(opts.context ?? []).map((text) => ({
      text: clip(text, MAX_CONTEXT_CHARS),
    })),
  ]);
  if (badFigures.length) {
    codeOutcome = worst(codeOutcome, 'hold');
    codeHazards.push({
      hazard: 'unsupported_figure',
      value: 1,
      source: 'code',
    });
    codeReasons.push('CODE_UNSUPPORTED_FIGURE');
  }
  return {
    codeOutcome,
    codeHazards,
    codeReasons,
    codeLog: { badFigures, nonPartner: nonPartner.map((b) => b.code) },
  };
}

/** Outcome from code layer + model answers under thresholds (the trusted, non-degraded path). */
export function combineGuardrail(
  codeOutcome: GuardrailOutcome,
  answers: GuardAnswers,
  t: GuardrailThresholds
): GuardrailOutcome {
  const r = routeGuardrail(answers, t);
  let outcome = worst(codeOutcome, r.outcome);
  if (outcome === 'hold' && answers.severity.score >= t.severityBlock)
    outcome = 'block';
  return outcome;
}

/** Per-field caps: the documented state budget is 32k tokens, and Arabic tokenises densely. */
const MAX_MESSAGE_CHARS = 4000;
const MAX_PASSAGE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 4000;

/**
 * Redacted TypeSafe state for check C. Shared with the evaluation harness.
 * Evidence ids are ordinals (e1, e2…): no question refers to them, and a
 * database UUID with nine digits in a row reads as an identifier to the
 * last-line PII guard, which would withhold the whole request.
 */
export function buildGuardrailState(
  input: Pick<
    GuardrailInput,
    'customerMessage' | 'botReply' | 'evidence' | 'context' | 'partners'
  >
): GuardrailState {
  return {
    customer_message: redactClipped(input.customerMessage, MAX_MESSAGE_CHARS, {
      tail: true,
    }),
    bot_reply: redactClipped(input.botReply, MAX_MESSAGE_CHARS),
    evidence_passages: input.evidence.map((e, i) => ({
      id: `e${i + 1}`,
      text: redactClipped(e.text, MAX_PASSAGE_CHARS),
    })),
    context_passages: (input.context ?? [])
      .filter((c) => c.trim())
      .map((c) => redactClipped(c, MAX_CONTEXT_CHARS)),
    partner_banks: (input.partners ?? partnerCatalogue(null)).display,
  };
}

export async function runGuardrail(
  deps: CheckDeps,
  input: GuardrailInput
): Promise<GuardrailDecision> {
  const { codeOutcome, codeHazards, codeReasons, codeLog } = codeLayer(
    input.botReply,
    input.evidence,
    {
      customerMessage: input.customerMessage,
      context: input.context,
      partners: input.partners,
    }
  );

  // Off for this account (or on this install): no policy read, no
  // request, no log — and never degraded.
  const cs = await stateFor(deps, 'guardrail', input.accountId);
  if (!cs.on) {
    return {
      policyVersion: null,
      shadowReasons: ['DISABLED'],
      outcome: 'send',
      hazards: codeHazards,
      rmTaskReason: null,
      act: false,
      shadow: true,
      fallbackUsed: false,
      errorCode: 'DISABLED',
      reasonCodes: codeReasons,
      modelId: null,
      decisionId: null,
      latencyMs: 0,
    };
  }

  const policy = await deps.policies.get('guardrail', input.accountId);
  const state = buildGuardrailState(input);
  const res = await deps.gateway.ask(
    'guardrail',
    state,
    GUARDRAIL_QUESTIONS,
    input.accountId
  );

  /*
   * Shadow semantics for the guardrail (invariant: while on and live, an
   * unscreened reply is never sent):
   *  - intentional shadow = the account chose "Monitor only", the install
   *    forces it (TS_SHADOW / TS_SHADOW_GUARDRAIL), or the account's
   *    approved custom policy says shadow
   *      → compute and log only; host sends as today (act=false).
   *  - live runs on the built-in thresholds unless the account has an
   *    approved custom policy for this model and question set.
   *  - degraded = the screen could not be trusted for this reply: TypeSafe
   *    unavailable or refused the request, or answered with another model
   *      → fail mode (hold|send) combined with the code layer, and ACT on it.
   *  - language shadow = the REPLY's language is not calibrated yet
   *      → the code layer acts as usual, and a model flag — uncalibrated,
   *        so it may be wrong — can only send the draft to a person
   *        (hold), never block it, never let it through. The bot answers
   *        in the customer's language, so "log only" here would let a
   *        customer writing in Arabic switch the model screen off.
   */
  const replyLanguage = detectLanguage(input.botReply);
  const langShadow = cs.shadowLanguages.includes(replyLanguage);
  const intentionalShadow = cs.monitor || policy.shadow;
  const shadowReasons = [...policy.shadowReasons];
  if (cs.monitor) shadowReasons.push('MONITOR');
  if (res.ok && res.modelMismatch)
    shadowReasons.push('RESPONSE_MODEL_MISMATCH');
  if (langShadow) shadowReasons.push(`LANGUAGE_SHADOW:${replyLanguage}`);
  const degraded = !res.ok || res.modelMismatch;

  let hazards = [...codeHazards];
  let reasons = [...codeReasons];
  let modelOutcome: GuardrailOutcome = 'send';
  if (res.ok) {
    const r = routeGuardrail(res.result.answers, policy.thresholds);
    modelOutcome = r.outcome;
    hazards = [...hazards, ...r.hazards];
    reasons = [...reasons, ...r.reasons];
  }

  let outcome: GuardrailOutcome;
  let act = !intentionalShadow;
  if (intentionalShadow) {
    outcome = worst(codeOutcome, modelOutcome);
  } else if (degraded) {
    // A request withheld or refused for its content (an identifier the
    // redaction missed, an oversized state) is not an outage: a person
    // looks at it whatever the fail mode says.
    const contentFailure =
      !res.ok &&
      (res.errorCode === 'PII_BLOCKED' || res.errorCode === 'STATE_TOO_LARGE');
    const failMode = contentFailure ? 'hold' : deps.config.guardrailFailMode;
    // An untrusted model answer can only make the outcome stricter, never looser.
    outcome = worst(worst(codeOutcome, failMode), modelOutcome);
    reasons.push(`DEGRADED_${failMode.toUpperCase()}`);
    if (!res.ok) reasons.push('TS_UNAVAILABLE');
  } else if (langShadow) {
    // The model is uncalibrated for this language: its flags go to a
    // person for review, the code layer's findings apply as usual.
    const modelReview: GuardrailOutcome =
      modelOutcome === 'send' ? 'send' : 'hold';
    outcome = worst(codeOutcome, modelReview);
    act = outcome !== 'send';
    reasons.push(
      modelReview === 'hold'
        ? 'LANGUAGE_SHADOW_MODEL_REVIEW'
        : 'LANGUAGE_SHADOW_CODE_ONLY'
    );
  } else {
    outcome = worst(codeOutcome, modelOutcome);
    // Severity also upgrades a code-layer hold
    if (
      res.ok &&
      outcome === 'hold' &&
      res.result.answers.severity.score >= policy.thresholds.severityBlock &&
      !reasons.includes('SEVERITY_UPGRADE')
    ) {
      outcome = 'block';
      hazards.push({
        hazard: 'severity',
        value: res.result.answers.severity.score,
        source: 'model',
      });
      reasons.push('SEVERITY_UPGRADE');
    }
  }

  // The account's custom policy could not be read and none was loaded
  // before: the built-in thresholds screened this reply. Recorded so the
  // log says so.
  if (policy.loadError) reasons.push('POLICY_UNAVAILABLE');

  // A hold that only the fail mode produced (nothing in the reply was
  // flagged) is labelled an outage, not a finding, so the log and alerts
  // tell the two apart. A content failure (PII_BLOCKED, oversized) is a
  // review. The host hands both over the same way.
  const outageHold =
    outcome === 'hold' &&
    degraded &&
    codeOutcome === 'send' &&
    modelOutcome === 'send' &&
    !(
      !res.ok &&
      (res.errorCode === 'PII_BLOCKED' || res.errorCode === 'STATE_TOO_LARGE')
    );
  const rmTaskReason: GuardrailDecision['rmTaskReason'] =
    outcome === 'block'
      ? 'GUARDRAIL_BLOCK'
      : outcome === 'hold'
        ? outageHold
          ? 'GUARDRAIL_UNAVAILABLE'
          : 'GUARDRAIL_REVIEW'
        : null;

  const decisionId = await deps.logger.write({
    check: 'guardrail',
    ...refOf(input),
    policyVersion: policy.version,
    modelId: res.ok ? res.result.model : null,
    questionSetVersion: QS_VERSION,
    language: replyLanguage,
    redactedState: state,
    answers: res.ok
      ? {
          ...res.result.answers,
          code: codeLog,
          evidence_ids: input.evidence.map((e) => e.id),
          request_id: res.requestId ?? null,
        }
      : { code: codeLog, evidence_ids: input.evidence.map((e) => e.id) },
    decision: outcome,
    reasonCodes: reasons,
    acted: act,
    shadow: !act,
    fallbackUsed: degraded,
    latencyMs: res.latencyMs,
    inputTokens: res.ok ? res.result.usage.input_tokens : null,
    errorCode: res.ok ? null : res.errorCode,
  });

  return {
    outcome,
    hazards,
    rmTaskReason,
    act,
    shadow: !act,
    shadowReasons: [...new Set(shadowReasons)],
    fallbackUsed: degraded,
    errorCode: res.ok ? null : res.errorCode,
    reasonCodes: reasons,
    policyVersion: policy.version,
    modelId: res.ok ? res.result.model : null,
    decisionId,
    latencyMs: res.latencyMs,
  };
}
