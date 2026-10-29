/**
 * Smart insights bands (docs/jev-insights.md): how Jev's customer signals
 * — the triage scales, whichever request produced them — become the
 * labels and priority the inbox, customer page, deals and home page show.
 *
 * Dependency-free on purpose: client components import it. It restates
 * the intent keys of `lib/typesafe/questions/triage.ts` rather than
 * importing them (bands.test.ts keeps the two equal).
 *
 * Every threshold here is UNCALIBRATED: a first judgment of where the
 * scales split, not fitted to labelled conversations. Change them here,
 * in one place, once real figures are reviewed.
 */

/** The triage INTENTS keys, in their order. */
export const INSIGHT_INTENT_KEYS = [
  'account_opening',
  'pos_terminal',
  'business_loan',
  'trade_working_capital',
  'application_status',
  'other_banking',
  'complaint',
  'smalltalk',
  'unclear',
  'other_request',
] as const;

export type InsightIntent = (typeof INSIGHT_INTENT_KEYS)[number];

type Figure = number | null | undefined;

const known = (x: Figure): x is number =>
  typeof x === 'number' && Number.isFinite(x);

// Lead temperature: expected level 0..3 (curiosity / comparing / intends
// to apply soon / ready now). Uncalibrated.
/** At or above: warm (leaning towards "comparing options"). */
export const LEAD_WARM_MIN = 0.6;
/** At or above: hot (leaning towards "intends to apply soon"). */
export const LEAD_HOT_MIN = 1.4;
/** At or above: ready (leaning towards "ready now"). */
export const LEAD_READY_MIN = 2.25;

export type LeadBand = 'cold' | 'warm' | 'hot' | 'ready';

/** The lead band of an expected lead temperature, or null when unknown. */
export function leadBand(t: Figure): LeadBand | null {
  if (!known(t)) return null;
  if (t >= LEAD_READY_MIN) return 'ready';
  if (t >= LEAD_HOT_MIN) return 'hot';
  if (t >= LEAD_WARM_MIN) return 'warm';
  return 'cold';
}

// Urgency: expected level 0..2 (no time pressure / wants progress soon /
// a deadline or business impact today). Uncalibrated.
/** At or above: soon. */
export const URGENCY_SOON_MIN = 0.8;
/** At or above: urgent. */
export const URGENCY_URGENT_MIN = 1.5;

export type UrgencyBand = 'none' | 'soon' | 'urgent';

/** The urgency band of an expected urgency, or null when unknown. */
export function urgencyBand(u: Figure): UrgencyBand | null {
  if (!known(u)) return null;
  if (u >= URGENCY_URGENT_MIN) return 'urgent';
  if (u >= URGENCY_SOON_MIN) return 'soon';
  return 'none';
}

/** P(dissatisfied) at or above which a customer shows as upset. Uncalibrated. */
export const UPSET_MIN = 0.7;
/** P(asks for a person) at or above which it shows. Uncalibrated. */
export const WANTS_PERSON_MIN = 0.8;

export const isUpset = (p: Figure): boolean => known(p) && p >= UPSET_MIN;
export const wantsPerson = (p: Figure): boolean =>
  known(p) && p >= WANTS_PERSON_MIN;

// Priority 2 (act now) thresholds. Uncalibrated.
export const PRIORITY_HIGH_URGENCY = URGENCY_URGENT_MIN;
export const PRIORITY_HIGH_UPSET = 0.85;
export const PRIORITY_HIGH_WANTS_HUMAN = 0.9;
// Priority 1 (soon) thresholds. Uncalibrated.
export const PRIORITY_MID_URGENCY = URGENCY_SOON_MIN;
export const PRIORITY_MID_UPSET = UPSET_MIN;
export const PRIORITY_MID_WANTS_HUMAN = WANTS_PERSON_MIN;
export const PRIORITY_MID_LEAD_TEMP = LEAD_READY_MIN;

/** `insight_priority` levels, as {@link priorityOf} returns them. */
export const PRIORITY_NONE = 0;
export const PRIORITY_HIGH = 1;
export const PRIORITY_URGENT = 2;

export type InsightPriority =
  typeof PRIORITY_NONE | typeof PRIORITY_HIGH | typeof PRIORITY_URGENT;

const atLeast = (x: Figure, min: number): boolean => known(x) && x >= min;

/**
 * 2: urgent, clearly upset or clearly asking for a person. 1: soon, upset,
 * asking for a person, or ready to apply. 0 otherwise. A null or missing
 * figure counts as absent, never as a high one.
 */
export function priorityOf(f: {
  urgency?: Figure;
  upset?: Figure;
  wantsHuman?: Figure;
  leadTemp?: Figure;
}): InsightPriority {
  if (
    atLeast(f.urgency, PRIORITY_HIGH_URGENCY) ||
    atLeast(f.upset, PRIORITY_HIGH_UPSET) ||
    atLeast(f.wantsHuman, PRIORITY_HIGH_WANTS_HUMAN)
  )
    return PRIORITY_URGENT;
  if (
    atLeast(f.urgency, PRIORITY_MID_URGENCY) ||
    atLeast(f.upset, PRIORITY_MID_UPSET) ||
    atLeast(f.wantsHuman, PRIORITY_MID_WANTS_HUMAN) ||
    atLeast(f.leadTemp, PRIORITY_MID_LEAD_TEMP)
  )
    return PRIORITY_HIGH;
  return PRIORITY_NONE;
}

/** A chat-tag suggestion below this probability is neither stored nor
 *  shown. Uncalibrated. */
export const TAG_SUGGEST_MIN_P = 0.55;

// ── Customer insights (qs-insights-v2) ──────────────────────────────────

/** The objection codes, in display order. `DEEP_QUESTIONS` in
 *  lib/typesafe/questions/insights.ts asks `objection_<code>` for each. */
export const OBJECTION_CODES = [
  'price',
  'documents',
  'eligibility',
  'trust',
  'timing',
  'comparing',
] as const;

export type ObjectionCode = (typeof OBJECTION_CODES)[number];

/** P(objection) at or above which it shows. Uncalibrated. */
export const OBJECTION_MIN_P = 0.6;

/** The objections at or above {@link OBJECTION_MIN_P}, in
 *  {@link OBJECTION_CODES} order. A missing, null or NaN figure is absent. */
export function objectionsFrom(
  map: Partial<Record<ObjectionCode, Figure>> | null | undefined
): ObjectionCode[] {
  if (!map) return [];
  return OBJECTION_CODES.filter((c) => atLeast(map[c], OBJECTION_MIN_P));
}

/** P(the message expects an answer) at or above which it shows as
 *  waiting for a reply. Uncalibrated. */
export const NEEDS_REPLY_MIN_P = 0.6;
/** P(asks for a call) at or above which it shows. Uncalibrated. */
export const CALLBACK_MIN_P = 0.7;

// Sentiment: expected level 0..4 (very negative / negative / neutral /
// positive / very positive). Uncalibrated.
/** Below: very negative. */
export const SENTIMENT_NEGATIVE_MIN = 1;
/** Below: negative. */
export const SENTIMENT_NEUTRAL_MIN = 1.75;
/** Below: neutral. */
export const SENTIMENT_POSITIVE_MIN = 2.5;
/** Below: positive; at or above: very positive. */
export const SENTIMENT_VERY_POSITIVE_MIN = 3.25;

export type SentimentBand =
  'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';

/** The sentiment band of an expected sentiment, or null when unknown. */
export function sentimentBand(s: Figure): SentimentBand | null {
  if (!known(s)) return null;
  if (s < SENTIMENT_NEGATIVE_MIN) return 'very_negative';
  if (s < SENTIMENT_NEUTRAL_MIN) return 'negative';
  if (s < SENTIMENT_POSITIVE_MIN) return 'neutral';
  if (s < SENTIMENT_VERY_POSITIVE_MIN) return 'positive';
  return 'very_positive';
}

/** Why a chat needs attention, highest precedence first. */
export const ATTENTION_REASONS = [
  'urgent',
  'wants_person',
  'upset',
  'callback',
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

// Attention thresholds: stricter than the badges, because attention
// interrupts someone. Uncalibrated.
export const ATTENTION_WANTS_PERSON_P = 0.85;
export const ATTENTION_UPSET_P = 0.85;
export const ATTENTION_CALLBACK_P = 0.75;

/** Which attention reasons the workspace has switched on. */
export interface AttentionRules {
  urgent: boolean;
  upset: boolean;
  wantsPerson: boolean;
  callback: boolean;
}

export interface AttentionFigures {
  urgency?: Figure;
  upset?: Figure;
  wantsHuman?: Figure;
  leadTemp?: Figure;
  callback?: Figure;
}

/**
 * The highest-precedence {@link ATTENTION_REASONS} entry whose rule is on
 * and whose condition holds, else null. `urgent` is {@link priorityOf} at
 * {@link PRIORITY_URGENT}. A null, missing or NaN figure counts as absent.
 */
export function attentionReason(
  f: AttentionFigures,
  rules: AttentionRules
): AttentionReason | null {
  if (rules.urgent && priorityOf(f) === PRIORITY_URGENT) return 'urgent';
  if (rules.wantsPerson && atLeast(f.wantsHuman, ATTENTION_WANTS_PERSON_P))
    return 'wants_person';
  if (rules.upset && atLeast(f.upset, ATTENTION_UPSET_P)) return 'upset';
  if (rules.callback && atLeast(f.callback, ATTENTION_CALLBACK_P))
    return 'callback';
  return null;
}
