import {
  inCampaignInbox,
  type CampaignInboxFields,
} from '@/lib/inbox/campaign-inbox';

import {
  ATTENTION_REASONS,
  CALLBACK_MIN_P,
  INSIGHT_INTENT_KEYS,
  LEAD_HOT_MIN,
  NEEDS_REPLY_MIN_P,
  OBJECTION_CODES,
  UPSET_MIN,
  isUpset,
  leadBand,
  sentimentBand,
  urgencyBand,
  wantsPerson,
  type AttentionReason,
  type InsightIntent,
  type LeadBand,
  type ObjectionCode,
  type SentimentBand,
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

/** The conversation columns the card reads (`id` for its history and
 *  the Mark handled call). */
export interface CustomerInsightFigures {
  id?: string;
  insight_intent?: string | null;
  insight_intent_p?: Figure;
  insight_urgency?: Figure;
  insight_lead_temp?: Figure;
  insight_upset?: Figure;
  insight_wants_human?: Figure;
  insight_at?: string | null;
  // Migration 153.
  insight_sentiment?: Figure;
  insight_objections?: readonly string[] | null;
  insight_needs_reply?: Figure;
  insight_callback?: Figure;
  insight_attention_at?: string | null;
  insight_attention_reason?: string | null;
  /** Read by the next best action's "reply now". */
  unread_count?: Figure;
}

/** The select list for those columns (customer page, one per contact). */
export const CUSTOMER_INSIGHT_COLUMNS =
  'insight_intent, insight_intent_p, insight_urgency, insight_lead_temp, insight_upset, insight_wants_human, insight_at, insight_sentiment, insight_objections, insight_needs_reply, insight_callback, insight_attention_at, insight_attention_reason, unread_count';

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
  sentiment: SentimentBand | null;
  /** Known codes only, in `OBJECTION_CODES` order, each once. */
  objections: ObjectionCode[];
  /** The customer expects an answer (`NEEDS_REPLY_MIN_P`). */
  needsReply: boolean;
  /** The customer asked for a call (`CALLBACK_MIN_P`). */
  callback: boolean;
  /** The chat is pinned until a person acts; `reason` null when the
   *  stored reason is not one this build knows. */
  attention: { reason: AttentionReason | null; since: Date } | null;
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

const REASONS: ReadonlySet<string> = new Set(ATTENTION_REASONS);

function attentionOf(
  row: CustomerInsightFigures
): CustomerInsightView['attention'] {
  const since = dateOf(row.insight_attention_at);
  if (!since) return null;
  const r = row.insight_attention_reason;
  return {
    reason: r && REASONS.has(r) ? (r as AttentionReason) : null,
    since,
  };
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
  const sentiment = sentimentBand(r.insight_sentiment);
  const raw = new Set(r.insight_objections ?? []);
  const objections = OBJECTION_CODES.filter((c) => raw.has(c));
  return {
    judged: !!(
      intent ||
      lead ||
      urgency ||
      mood ||
      sentiment ||
      objections.length > 0
    ),
    intent,
    intentPercent,
    lead,
    meter: leadMeter(lead),
    urgency,
    mood,
    basedOnAt: dateOf(r.insight_at),
    sentiment,
    objections,
    needsReply:
      known(r.insight_needs_reply) &&
      r.insight_needs_reply >= NEEDS_REPLY_MIN_P,
    callback: known(r.insight_callback) && r.insight_callback >= CALLBACK_MIN_P,
    attention: attentionOf(r),
  };
}

// ---------------------------------------------------------------------------
// Home tiles
// ---------------------------------------------------------------------------

/** The columns a home tile's read needs beyond the unread row's own. */
export const INSIGHT_TILE_COLUMNS = 'insight_lead_temp, insight_upset';

/**
 * The tiles' read: unread chats that are hot or upset, as an `or`
 * group. The tiles then count these rows through
 * {@link countInsightTiles}, with the same Campaign inbox exclusion as
 * the unread tile.
 */
export const INSIGHT_TILE_OR = `insight_lead_temp.gte.${LEAD_HOT_MIN},insight_upset.gte.${UPSET_MIN}`;

/**
 * "Hot leads waiting" and "Upset customers waiting": hot (the Inbox's Hot
 * leads filter) or upset (its Upset filter) AND unread, among the chats
 * the Inbox lists (`inCampaignInbox` ones excluded, as the unread tile
 * does). Conversations record no "who wrote last", so unread stands for
 * "the customer wrote last and nobody has opened it since". Each count
 * is exactly what its tile's link shows.
 */
export function countInsightTiles(
  rows: readonly (CampaignInboxFields & {
    unread_count?: number | null;
    insight_lead_temp?: number | null;
    insight_upset?: number | null;
  })[],
  aiLive: boolean
): { hotWaiting: number; upsetWaiting: number } {
  let hotWaiting = 0;
  let upsetWaiting = 0;
  for (const row of rows) {
    if ((row.unread_count ?? 0) <= 0 || inCampaignInbox(row, aiLive)) continue;
    const { insight_lead_temp: lead, insight_upset: upset } = row;
    if (typeof lead === 'number' && lead >= LEAD_HOT_MIN) hotWaiting += 1;
    if (typeof upset === 'number' && upset >= UPSET_MIN) upsetWaiting += 1;
  }
  return { hotWaiting, upsetWaiting };
}

/** The Pinned chats tile: the inbox with the Pinned chip on. */
export function pinnedTileHref(inboxPath: string): string {
  return `${inboxPath}?pinned=1`;
}

/** Where a tile goes: the inbox, Unread, with the matching Smart insights filter. */
export function insightTileHref(
  inboxPath: string,
  filter: 'hot' | 'upset'
): string {
  return `${inboxPath}?insight=${filter}&filter=unread`;
}
