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
