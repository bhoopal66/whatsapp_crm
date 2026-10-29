import {
  INSIGHT_INTENT_KEYS,
  LEAD_HOT_MIN,
  UPSET_MIN,
  isUpset,
  leadBand,
  urgencyBand,
  wantsPerson,
  type InsightIntent,
  type LeadBand,
  type UrgencyBand,
} from './bands';

/**
 * Smart insights on the customer panel, the customer page and the home
 * page (docs/jev-insights.md, "Customer insights"): what the insights
 * card shows of a conversation's `insight_*` figures, and the bounds of
 * the two home tiles. Dependency-free (bands.ts only) because client
 * components import it; the card and the tiles hold no rules of their
 * own.
 */

type Figure = number | null | undefined;

const known = (x: Figure): x is number =>
  typeof x === 'number' && Number.isFinite(x);

/** The conversation columns the card reads. */
export interface CustomerInsightFigures {
  insight_intent?: string | null;
  insight_intent_p?: Figure;
  insight_urgency?: Figure;
  insight_lead_temp?: Figure;
  insight_upset?: Figure;
  insight_wants_human?: Figure;
  insight_at?: string | null;
}

/** The select list for those columns (customer page, one per contact). */
export const CUSTOMER_INSIGHT_COLUMNS =
  'insight_intent, insight_intent_p, insight_urgency, insight_lead_temp, insight_upset, insight_wants_human, insight_at';

/** The lead meter's four steps, coldest first. */
export const LEAD_METER_STEPS: readonly LeadBand[] = [
  'cold',
  'warm',
  'hot',
  'ready',
];

export interface LeadMeterStep {
  band: LeadBand;
  /** The band the customer is in now. */
  current: boolean;
  /** At or below the current band: the meter is filled up to here. */
  reached: boolean;
}

export type MoodTag = 'upset' | 'wantsPerson' | 'calm';

export interface CustomerInsightView {
  /** Jev has judged at least one figure of this chat. */
  judged: boolean;
  /** Null for an unknown key or no judgment. */
  intent: InsightIntent | null;
  /** How sure Jev is of the intent, 0..100; null without an intent. */
  intentPercent: number | null;
  lead: LeadBand | null;
  /** Empty when the lead temperature is unknown. */
  meter: LeadMeterStep[];
  urgency: UrgencyBand | null;
  /** Upset and/or Wants a person, else Calm; null when nothing is known. */
  mood: MoodTag[] | null;
  /** When the judged message arrived; null when unknown or invalid. */
  basedOnAt: Date | null;
}

const INTENTS: ReadonlySet<string> = new Set(INSIGHT_INTENT_KEYS);

export function leadMeter(lead: LeadBand | null): LeadMeterStep[] {
  if (!lead) return [];
  const at = LEAD_METER_STEPS.indexOf(lead);
  return LEAD_METER_STEPS.map((band, i) => ({
    band,
    current: i === at,
    reached: i <= at,
  }));
}

function moodOf(row: CustomerInsightFigures): MoodTag[] | null {
  const tags: MoodTag[] = [];
  if (isUpset(row.insight_upset)) tags.push('upset');
  if (wantsPerson(row.insight_wants_human)) tags.push('wantsPerson');
  if (tags.length > 0) return tags;
  // Calm only when the upset figure is known: an unjudged mood says nothing.
  return known(row.insight_upset) ? ['calm'] : null;
}

function dateOf(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function customerInsightView(
  row: CustomerInsightFigures | null | undefined
): CustomerInsightView {
  const r = row ?? {};
  const rawIntent = r.insight_intent;
  const intent =
    rawIntent && INTENTS.has(rawIntent) ? (rawIntent as InsightIntent) : null;
  const p = r.insight_intent_p;
  const intentPercent =
    intent && known(p) && p >= 0 && p <= 1 ? Math.round(p * 100) : null;
  const lead = leadBand(r.insight_lead_temp);
  const urgency = urgencyBand(r.insight_urgency);
  const mood = moodOf(r);
  return {
    judged: !!(intent || lead || urgency || mood),
    intent,
    intentPercent,
    lead,
    meter: leadMeter(lead),
    urgency,
    mood,
    basedOnAt: dateOf(r.insight_at),
  };
}

// ---------------------------------------------------------------------------
// Home tiles
// ---------------------------------------------------------------------------

/**
 * "Hot leads waiting": lead temperature at least hot (the Inbox's Hot
 * leads filter) and unread. Conversations record no "who wrote last",
 * so an unread chat stands for "the customer wrote last and nobody has
 * opened it since".
 */
export const HOT_LEADS_WAITING = {
  leadTempMin: LEAD_HOT_MIN,
  unreadAbove: 0,
} as const;

/**
 * "Upset customers today": upset at least the Upset band, judged on a
 * message that arrived since `dayStartMs` (midnight in the home page's
 * zone).
 */
export function upsetTodayBounds(dayStartMs: number): {
  upsetMin: number;
  atFromIso: string;
} {
  return { upsetMin: UPSET_MIN, atFromIso: new Date(dayStartMs).toISOString() };
}

/** Where a tile goes: the inbox with the matching Smart insights filter. */
export function insightTileHref(
  inboxPath: string,
  filter: 'hot' | 'upset'
): string {
  return `${inboxPath}?insight=${filter}`;
}
