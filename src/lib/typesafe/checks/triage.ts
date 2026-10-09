/**
 * Check A + B — inbound triage and opt-out safety net (one TypeSafe request).
 * Hook 1: call AFTER the webhook has returned 200 to Meta, and AFTER module
 * 012's keyword-STOP handling. Never writes journey state.
 */
import {
  detectBanksIn,
  partnerCatalogue,
  type PartnerCatalogue,
} from '../banks';
import type { TriageThresholds } from '../policy';

import { detectLanguage } from '../redact';
import {
  QS_VERSION,
  TRIAGE_QUESTIONS,
  type Intent,
  type TriageState,
} from '../questions/triage';
import {
  redactClipped,
  type CheckDeps,
  type DecisionMeta,
  type Ref,
  stateFor,
} from './common';

export type TriageRoute =
  'bot' | 'bot_restricted' | 'rm' | 'opted_out' | 'host_default';
export type Priority = 'normal' | 'high' | 'urgent';

export interface TriageInput extends Ref {
  /**
   * `watch`: a conversation people handle, judged only to catch an
   * opt-out. The host acts on nothing else, so only an opt-out counts as
   * acted in the log.
   */
  source?: 'bot' | 'watch';
  /** Everything the customer wrote since the bot last spoke (a burst of
   *  short messages is one turn to judge, joined with newlines). */
  message: string;
  recentTurns?: { from: 'customer' | 'taamul'; text: string }[];
  journeyStage: string;
  /** The account's bank dictionary (DecisionLayer.partners). Absent: the
   *  built-in partner list. */
  partners?: PartnerCatalogue;
}

export interface TriageDecision extends DecisionMeta {
  route: TriageRoute;
  /** record = write opt-out to consent register (source TS_FREE_TEXT) and send confirmation template.
   *  suppress_pending_review = suppress marketing sends and keep the bot silent until an RM reviews (1 working day). */
  optOut: 'record' | 'suppress_pending_review' | 'none';
  rmTask: { reasons: string[]; priority: Priority } | null;
  callbackTask: boolean;
  /** How time-sensitive the customer says this is ('urgent' = a deadline
   *  or business impact today). 'normal' whenever there is no judgement. */
  urgency: Priority;
  nonPartnerBank: {
    /** The customer asks for something at a non-partner bank (model). */
    detected: boolean;
    /** Non-partner banks the dictionary found in the message, even in passing. */
    banks: string[];
    source: 'model' | null;
  };
  flags: { dissatisfied: boolean; instructsAssistant: boolean };
  intent: Intent | null;
  intentConfidence: number | null;
}

const PRIORITY_RANK: Record<Priority, number> = {
  normal: 0,
  high: 1,
  urgent: 2,
};
const maxPriority = (a: Priority, b: Priority): Priority =>
  PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
const MAX_TURNS = 6;

export type TriageAnswers = {
  intent: {
    choice: Intent;
    confidence: number;
    /** Per-option probabilities (the API returns them for every Choice). */
    probabilities?: Partial<Record<Intent, number>>;
  };
  wants_human: { noul: number };
  non_partner_bank: { noul: number };
  dissatisfied: { noul: number };
  instructs_assistant: { noul: number };
  urgency: { score: number; confidence: number };
  lead_temperature: { score: number; confidence: number };
  opt_out: { noul: number };
};

/** Pure routing function — spec §7, check A/B rows. Exported for tests and re-routing from logs. */
export function routeTriage(
  a: TriageAnswers,
  t: TriageThresholds,
  dictionaryNonPartner: string[]
) {
  const reasons: string[] = [];
  const rmReasons: string[] = [];
  let route: TriageRoute = 'bot';
  let optOut: TriageDecision['optOut'] = 'none';
  let priority: Priority = 'normal';

  const urgencyPriority: Priority =
    a.urgency.score >= t.urgencyUrgentMin
      ? 'urgent'
      : a.urgency.score >= t.urgencyHighMin
        ? 'high'
        : 'normal';

  // B — opt-out (add-only)
  if (a.opt_out.noul >= t.optOutRecordMin) {
    reasons.push('OPT_OUT_RECORD');
    // A complaint or a request for a person in the same message still reaches an RM
    // (service follow-up, not marketing).
    const followUp: string[] = [];
    if (a.wants_human.noul >= t.wantsHumanMin)
      followUp.push('OPT_OUT_WITH_HUMAN_REQUEST');
    if (
      a.intent.choice === 'complaint' &&
      a.intent.confidence >= t.complaintConfidenceMin
    )
      followUp.push('OPT_OUT_WITH_COMPLAINT');
    reasons.push(...followUp);
    return {
      route: 'opted_out' as TriageRoute,
      optOut: 'record' as const,
      rmTask: followUp.length
        ? { reasons: followUp, priority: urgencyPriority }
        : null,
      callbackTask: false,
      urgency: urgencyPriority,
      reasons,
      nonPartner: a.non_partner_bank.noul >= t.nonPartnerBankMin,
    };
  }
  if (a.opt_out.noul >= t.optOutReviewMin) {
    // Possible opt-out: suppress marketing AND keep the bot silent until an RM reviews.
    optOut = 'suppress_pending_review';
    route = 'rm';
    reasons.push('OPT_OUT_REVIEW');
    rmReasons.push('OPT_OUT_REVIEW');
  }

  // A — routing. Every intent but a complaint goes to the same bot, so
  // uncertainty between, say, an account and a POS terminal is no reason to
  // pull in a person (Choice confidence falls whenever probability spreads,
  // and with ten options it spreads often). Uncertainty hands off only when
  // a complaint is a real possibility.
  const complaintP =
    a.intent.choice === 'complaint'
      ? 1
      : (a.intent.probabilities?.complaint ?? 0);
  if (
    a.intent.confidence < t.intentConfidenceMin &&
    complaintP >= t.possibleComplaintMin
  ) {
    route = 'rm';
    rmReasons.push('TRIAGE_UNCERTAIN');
    priority = maxPriority(priority, urgencyPriority);
  }
  if (a.wants_human.noul >= t.wantsHumanMin) {
    route = 'rm';
    rmReasons.push('HUMAN_REQUEST');
    priority = maxPriority(priority, urgencyPriority);
  }
  if (
    a.intent.choice === 'complaint' &&
    a.intent.confidence >= t.complaintConfidenceMin
  ) {
    route = 'rm';
    rmReasons.push('COMPLAINT');
    priority = maxPriority(priority, urgencyPriority);
  }
  if (a.instructs_assistant.noul >= t.instructsAssistantMin) {
    reasons.push('INSTRUCTS_ASSISTANT');
    if (route === 'bot') route = 'bot_restricted';
  }
  // The model question asks about a *request* at a non-partner bank; the
  // dictionary also fires on a passing mention ("I bank with ENBD today"),
  // so a dictionary hit alone is logged but does not flag the turn.
  const nonPartner = a.non_partner_bank.noul >= t.nonPartnerBankMin;
  if (nonPartner) reasons.push('NON_PARTNER_BANK');
  else if (dictionaryNonPartner.length)
    reasons.push('NON_PARTNER_BANK_MENTION');
  if (a.dissatisfied.noul >= t.dissatisfiedMin) reasons.push('DISSATISFIED');

  const callbackTask =
    a.lead_temperature.score >= t.leadTemperatureMin &&
    a.lead_temperature.confidence >= t.leadTemperatureConfMin;
  if (callbackTask) reasons.push('LEAD_HOT_CALLBACK');

  reasons.push(...rmReasons.filter((r) => !reasons.includes(r)));
  return {
    route,
    optOut,
    rmTask: rmReasons.length
      ? { reasons: [...new Set(rmReasons)], priority }
      : null,
    callbackTask,
    urgency: urgencyPriority,
    reasons,
    nonPartner,
  };
}

const MAX_MESSAGE_CHARS = 4000;
const MAX_TURN_CHARS = 1000;

/** Redacted TypeSafe state for check A/B. Shared with the evaluation harness. */
export function buildTriageState(
  input: Pick<
    TriageInput,
    'message' | 'recentTurns' | 'journeyStage' | 'partners'
  >
): TriageState {
  return {
    // Tail-clipped: the newest line of a burst is the one that matters.
    message: redactClipped(input.message, MAX_MESSAGE_CHARS, { tail: true }),
    recent_turns: (input.recentTurns ?? []).slice(-MAX_TURNS).map((t) => ({
      from: t.from,
      text: redactClipped(t.text, MAX_TURN_CHARS),
    })),
    journey_stage: input.journeyStage,
    partner_banks: (input.partners ?? partnerCatalogue(null)).display,
  };
}

export async function runTriage(
  deps: CheckDeps,
  input: TriageInput
): Promise<TriageDecision> {
  const catalogue = input.partners ?? partnerCatalogue(null);
  const dictHits = detectBanksIn(input.message, catalogue.banks)
    .filter((b) => !b.partner)
    .map((b) => b.code);

  const base = {
    optOut: 'none' as const,
    rmTask: null,
    callbackTask: false,
    urgency: 'normal' as const,
    nonPartnerBank: {
      detected: false,
      banks: dictHits,
      source: null,
    },
    flags: { dissatisfied: false, instructsAssistant: false },
    intent: null,
    intentConfidence: null,
  };

  // Off for this account (or on this install): no policy read, no
  // request, no log.
  const cs = await stateFor(deps, 'triage', input.accountId);
  if (!cs.on) {
    return {
      ...base,
      policyVersion: null,
      shadowReasons: ['DISABLED'],
      route: 'host_default',
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

  const policy = await deps.policies.get('triage', input.accountId);
  const monitorReasons = cs.monitor ? ['MONITOR'] : [];
  const meta = {
    policyVersion: policy.version,
    shadowReasons: [...policy.shadowReasons, ...monitorReasons],
  };
  const watch = input.source === 'watch';
  const state = buildTriageState(input);

  const res = await deps.gateway.ask(
    'triage',
    state,
    TRIAGE_QUESTIONS,
    input.accountId
  );

  if (!res.ok) {
    const decisionId = await deps.logger.write({
      check: 'triage',
      ...refOf(input),
      policyVersion: policy.version,
      modelId: null,
      questionSetVersion: QS_VERSION,
      language: detectLanguage(input.message),
      redactedState: state,
      answers: null,
      decision: 'host_default',
      reasonCodes: watch ? ['WATCH', 'FALLBACK'] : ['FALLBACK'],
      acted: false,
      shadow: policy.shadow || cs.monitor,
      fallbackUsed: true,
      latencyMs: res.latencyMs,
      inputTokens: null,
      errorCode: res.errorCode,
    });
    return {
      ...base,
      ...meta,
      route: 'host_default',
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

  const a = res.result.answers;
  const r = routeTriage(a, policy.thresholds, dictHits);
  const lang = triageLanguage(input);
  const langShadow = cs.shadowLanguages.includes(lang);
  const shadowReasons = [
    ...policy.shadowReasons,
    ...monitorReasons,
    ...(res.modelMismatch ? ['RESPONSE_MODEL_MISMATCH'] : []),
    ...(langShadow ? [`LANGUAGE_SHADOW:${lang}`] : []),
  ];
  const shadow = cs.monitor || policy.shadow || res.modelMismatch || langShadow;
  const act = !shadow;

  const decisionId = await deps.logger.write({
    check: 'triage',
    ...refOf(input),
    policyVersion: policy.version,
    modelId: res.result.model,
    questionSetVersion: QS_VERSION,
    language: lang,
    redactedState: state,
    answers: { ...a, request_id: res.requestId ?? null },
    decision: r.route,
    reasonCodes: watch ? ['WATCH', ...r.reasons] : r.reasons,
    // Watching a conversation people handle, the host acts only on an
    // opt-out; anything else was judged, not acted on.
    acted: watch ? act && r.optOut === 'record' : act,
    shadow,
    fallbackUsed: false,
    latencyMs: res.latencyMs,
    inputTokens: res.result.usage.input_tokens,
    errorCode: null,
  });

  return {
    route: r.route,
    optOut: r.optOut,
    rmTask: r.rmTask,
    callbackTask: r.callbackTask,
    urgency: r.urgency,
    nonPartnerBank: {
      detected: r.nonPartner,
      banks: dictHits,
      source: r.nonPartner ? 'model' : null,
    },
    flags: {
      dissatisfied: r.reasons.includes('DISSATISFIED'),
      instructsAssistant: r.reasons.includes('INSTRUCTS_ASSISTANT'),
    },
    intent: a.intent.choice,
    intentConfidence: a.intent.confidence,
    act,
    shadow,
    shadowReasons: [...new Set(shadowReasons)],
    fallbackUsed: false,
    errorCode: null,
    reasonCodes: r.reasons,
    policyVersion: policy.version,
    modelId: res.result.model,
    decisionId,
    latencyMs: res.latencyMs,
  };
}

/**
 * The language a triage decision is judged in. A reply with no letters
 * ("١", "2", "👍") is read against the assistant's last turn, so its
 * language is that turn's: "١" answering an Arabic question is an Arabic
 * judgement, and stays in shadow while Arabic does.
 */
export function triageLanguage(
  input: Pick<TriageInput, 'message' | 'recentTurns'>
) {
  const own = detectLanguage(input.message);
  if (own !== 'unknown') return own;
  const last = [...(input.recentTurns ?? [])]
    .reverse()
    .find((t) => t.from === 'taamul');
  return last ? detectLanguage(last.text) : own;
}

export const refOf = (r: Ref) => ({
  accountId: r.accountId,
  contactId: r.contactId ?? null,
  conversationId: r.conversationId ?? null,
  messageId: r.messageId ?? null,
});
