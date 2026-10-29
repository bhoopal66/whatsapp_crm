import {
  INSIGHT_INTENT_KEYS,
  LEAD_HOT_MIN,
  PRIORITY_HIGH,
  PRIORITY_URGENT,
  UPSET_MIN,
  isUpset,
  leadBand,
  urgencyBand,
  wantsPerson,
  type InsightIntent,
  type LeadBand,
  type UrgencyBand,
} from '@/lib/insights/bands';
import type { Conversation } from '@/types';

import { compareForInbox, needsAttention } from './attention';

/**
 * Smart insights in the Inbox list (docs/jev-insights.md): the one badge
 * a row carries, the Hot leads / Upset / Needs attention filters and the
 * Urgent pin, over the `insight_*` figures Jev last judged (migration
 * 147). Pure and client-safe — bands.ts, attention.ts and types only —
 * so the list's rules are tested without a database or a DOM. None of
 * it applies unless the workspace switched signals on; the list passes
 * that flag in.
 */

type InsightRow = Pick<
  Conversation,
  | 'insight_intent'
  | 'insight_urgency'
  | 'insight_lead_temp'
  | 'insight_upset'
  | 'insight_wants_human'
  | 'insight_priority'
  | 'insight_at'
>;

const known = (x: number | null | undefined): x is number =>
  typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------------
// The row badge
// ---------------------------------------------------------------------------

export type InsightBadgeKind =
  'urgent' | 'upset' | 'wants_person' | 'ready' | 'hot';

/**
 * The one badge a row shows, by precedence: Urgent (priority 2) › Upset ›
 * Wants a person › Ready to apply › Hot lead › none. One at most, so the
 * row stays one line tall and the loudest thing wins.
 */
export function insightBadge(
  row: InsightRow,
  opts: { important?: boolean } = {}
): InsightBadgeKind | null {
  // A row already wearing the red Important pill does not also say
  // Urgent: the next badge in precedence shows instead (or none).
  if (!opts.important && (row.insight_priority ?? 0) >= PRIORITY_URGENT)
    return 'urgent';
  if (isUpset(row.insight_upset)) return 'upset';
  if (wantsPerson(row.insight_wants_human)) return 'wants_person';
  const lead = leadBand(row.insight_lead_temp);
  if (lead === 'ready') return 'ready';
  if (lead === 'hot') return 'hot';
  return null;
}

/** Everything known about a chat, for the badge's tooltip. */
export interface InsightSummary {
  lead: LeadBand | null;
  /** Null for an unjudged chat or a key this build does not know. */
  intent: InsightIntent | null;
  urgency: UrgencyBand | null;
  /** Null when the figure is unknown; false means calm. */
  upset: boolean | null;
  wantsPerson: boolean;
  /** When the last judged message arrived. */
  at: string | null;
}

const INTENTS: ReadonlySet<string> = new Set(INSIGHT_INTENT_KEYS);

export function insightSummary(row: InsightRow): InsightSummary {
  const intent = row.insight_intent;
  return {
    lead: leadBand(row.insight_lead_temp),
    intent: intent && INTENTS.has(intent) ? (intent as InsightIntent) : null,
    urgency: urgencyBand(row.insight_urgency),
    upset: known(row.insight_upset) ? isUpset(row.insight_upset) : null,
    wantsPerson: wantsPerson(row.insight_wants_human),
    at: row.insight_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const INSIGHT_FILTERS = ['hot', 'upset', 'attention'] as const;
export type InsightFilter = (typeof INSIGHT_FILTERS)[number];

type InsightFilterColumn =
  'insight_lead_temp' | 'insight_upset' | 'insight_priority';

/**
 * Each filter as one `column >= min` bound: the list pushes it into the
 * query (`.gte`) and re-applies it client-side through
 * {@link matchesInsightFilters}, from this one table, so the two can
 * never disagree.
 */
export const INSIGHT_FILTER_BOUNDS: Record<
  InsightFilter,
  { column: InsightFilterColumn; min: number }
> = {
  hot: { column: 'insight_lead_temp', min: LEAD_HOT_MIN },
  upset: { column: 'insight_upset', min: UPSET_MIN },
  attention: { column: 'insight_priority', min: PRIORITY_HIGH },
};

/** The bounds of the picked filters, in {@link INSIGHT_FILTERS} order. */
export function insightFilterBounds(
  filters: readonly InsightFilter[]
): { column: InsightFilterColumn; min: number }[] {
  return INSIGHT_FILTERS.filter((f) => filters.includes(f)).map(
    (f) => INSIGHT_FILTER_BOUNDS[f]
  );
}

/**
 * Whether a row passes every picked filter (they narrow together, like
 * the list's other facets). A missing figure never passes; no filter
 * always does.
 */
export function matchesInsightFilters(
  row: Pick<Conversation, InsightFilterColumn>,
  filters: readonly InsightFilter[]
): boolean {
  for (const { column, min } of insightFilterBounds(filters)) {
    const v = row[column];
    if (!known(v) || v < min) return false;
  }
  return true;
}

/** `?insight=hot,upset` → the known filters, deduplicated, in order. */
export function parseInsightFilters(raw: string | null): InsightFilter[] {
  if (!raw) return [];
  const asked = new Set(raw.split(',').map((s) => s.trim().toLowerCase()));
  return INSIGHT_FILTERS.filter((f) => asked.has(f));
}

// ---------------------------------------------------------------------------
// The Urgent pin
// ---------------------------------------------------------------------------

/**
 * The most urgent pins the first page asks for beside the normal page,
 * as `ATTENTION_LIMIT` (attention.ts) does for Important.
 * Urgent and unread is rare; past this they arrive with their page.
 */
export const URGENT_PIN_LIMIT = 50;

/**
 * What the first-page query needs from Smart insights. Until the
 * settings have loaded the list must wait (they report "off" meanwhile,
 * so it would load once without pins and filters and again with them);
 * with signals off it never asks for urgent pins or filter bounds, so
 * the list loads once, exactly as before.
 */
export function insightListQuery(input: {
  signalsEnabled: boolean;
  settingsLoading: boolean;
  insightFilters: readonly InsightFilter[];
}): {
  ready: boolean;
  urgentPins: boolean;
  bounds: { column: InsightFilterColumn; min: number }[];
} {
  if (input.settingsLoading)
    return { ready: false, urgentPins: false, bounds: [] };
  if (!input.signalsEnabled)
    return { ready: true, urgentPins: false, bounds: [] };
  return {
    ready: true,
    urgentPins: true,
    bounds: insightFilterBounds(input.insightFilters),
  };
}

/** Urgent (priority 2) and still unread: pinned under the Important pins. */
export function isUrgentPin(
  row: Pick<Conversation, 'insight_priority' | 'unread_count'>
): boolean {
  return (row.insight_priority ?? 0) >= PRIORITY_URGENT && row.unread_count > 0;
}

type Sortable = Pick<
  Conversation,
  | 'id'
  | 'last_message_at'
  | 'ai_attention_at'
  | 'insight_priority'
  | 'unread_count'
>;

/**
 * {@link compareForInbox} with the Urgent pin: Important chats first (as
 * before), then urgent unread chats newest message first, then the rest.
 * An Important chat that is also urgent stays with the Important ones.
 */
export function compareWithUrgentPins(a: Sortable, b: Sortable): number {
  if (!needsAttention(a) && !needsAttention(b)) {
    const aU = isUrgentPin(a);
    const bU = isUrgentPin(b);
    if (aU !== bU) return aU ? -1 : 1;
  }
  return compareForInbox(a, b);
}

/**
 * The list in display order: {@link compareWithUrgentPins} when signals
 * are on, else exactly `sortForInbox`'s order
 * (attention.ts). Returns a copy.
 */
export function sortForInboxWithInsights<T extends Sortable>(
  rows: readonly T[],
  urgentPins: boolean
): T[] {
  return rows
    .slice()
    .sort(urgentPins ? compareWithUrgentPins : compareForInbox);
}
