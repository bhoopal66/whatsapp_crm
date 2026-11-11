import {
  INSIGHT_INTENT_KEYS,
  LEAD_HOT_MIN,
  PRIORITY_HIGH,
  PRIORITY_URGENT,
  UPSET_MIN,
  isUpset,
  leadBand,
  sentimentBand,
  urgencyBand,
  wantsPerson,
  type InsightIntent,
  type LeadBand,
  type UrgencyBand,
} from '@/lib/insights/bands';
import {
  isPaletteKey,
  PALETTE_KEYS,
  type AttentionKey,
  type PaletteRef,
} from '@/lib/insights/palette';
import type { Conversation } from '@/types';

import { compareForInbox, needsAttention } from './attention';
import { inCampaignInbox, type CampaignInboxFields } from './campaign-inbox';
import {
  hasMessages,
  inRestrictedInbox,
  type RestrictableRow,
} from './pagination';
import { isOthersPersonalChat, type PersonalChatRow } from './personal-chats';
import type { InboxNarrowing } from './unread-counts';

/**
 * Smart insights in the Inbox list (docs/jev-insights.md): the one badge
 * a row carries, the Hot leads / Upset / Needs attention filters and the
 * pins until handled, over the `insight_*` figures Jev last judged (migration
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
// Pinned until handled (migration 153)
// ---------------------------------------------------------------------------

/**
 * The most attention pins (migration 153) the first page asks for
 * beside the normal page, as `ATTENTION_LIMIT` (attention.ts) does for
 * Important. The read is ordered by `insight_attention_at` ascending, so
 * when more than this many are pinned the ones waiting longest are the
 * ones loaded; the rest arrive with their page. 100 rather than 50 so a
 * busy morning's pins are all on screen at once.
 */
export const PIN_LIMIT = 100;

/**
 * What the first-page query needs from Smart insights. Until the
 * settings have loaded the list must wait (they report "off" meanwhile,
 * so it would load once without pins and filters and again with them);
 * with signals off it never asks for attention pins or filter bounds,
 * so the list loads once, exactly as before. `attentionPins` is the
 * bounded extra read of chats with `insight_attention_at` set
 * ({@link PIN_LIMIT}).
 */
export function insightListQuery(input: {
  signalsEnabled: boolean;
  settingsLoading: boolean;
  insightFilters: readonly InsightFilter[];
}): {
  ready: boolean;
  attentionPins: boolean;
  bounds: { column: InsightFilterColumn; min: number }[];
} {
  if (input.settingsLoading)
    return { ready: false, attentionPins: false, bounds: [] };
  if (!input.signalsEnabled)
    return { ready: true, attentionPins: false, bounds: [] };
  return {
    ready: true,
    attentionPins: true,
    bounds: insightFilterBounds(input.insightFilters),
  };
}

// ---------------------------------------------------------------------------
// Coloured rows (migration 153)
// ---------------------------------------------------------------------------

type SignalRow = InsightRow &
  Pick<
    Conversation,
    | 'insight_sentiment'
    | 'insight_attention_at'
    | 'insight_attention_reason'
    | 'ai_attention_at'
  >;

/** Why a chat is pinned and since when (an ISO timestamp, or null). */
export interface RowAttention {
  reason: AttentionKey;
  since: string | null;
}

export interface RowSignals {
  /** The row's left-border colour, or none. */
  stripe: PaletteRef | null;
  /** At most {@link ROW_CHIP_LIMIT}, most telling first. */
  chips: PaletteRef[];
  /** The pin's reason, or null when the chat is not pinned for one. */
  attention: RowAttention | null;
}

/** The most chips a row carries, so it stays one line tall. */
export const ROW_CHIP_LIMIT = 3;

/** Attention reasons, most severe first: the pin order. */
const SEVERITY: readonly AttentionKey[] = PALETTE_KEYS.attention;

/** Intents too vague to be worth a chip. */
const QUIET_INTENTS: ReadonlySet<string> = new Set(['smalltalk', 'unclear']);

function stamp(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

/**
 * The stored attention reason, if the stamp is set and the reason is one
 * this build knows. `ai_handoff` is never stored there (it is
 * `ai_attention_at`'s), so it does not count.
 */
function storedAttention(
  row: Pick<Conversation, 'insight_attention_at' | 'insight_attention_reason'>
): RowAttention | null {
  if (stamp(row.insight_attention_at) === null) return null;
  const reason = row.insight_attention_reason;
  if (!isPaletteKey('attention', reason) || reason === 'ai_handoff')
    return null;
  return { reason, since: row.insight_attention_at ?? null };
}

/**
 * The pin a row shows: the more severe of the stored attention reason
 * and the AI hand-off (Important). An attention stamp whose reason this
 * build does not know still pins the chat ({@link isPinned}) but names
 * no reason.
 */
function rowAttention(
  row: Pick<
    Conversation,
    'insight_attention_at' | 'insight_attention_reason' | 'ai_attention_at'
  >,
  important: boolean
): RowAttention | null {
  const stored = storedAttention(row);
  const handoff: RowAttention | null = important
    ? { reason: 'ai_handoff', since: row.ai_attention_at ?? null }
    : null;
  if (!stored) return handoff;
  if (!handoff) return stored;
  return SEVERITY.indexOf(handoff.reason) < SEVERITY.indexOf(stored.reason)
    ? handoff
    : stored;
}

/**
 * What colours an Inbox row. `important` is whether the row wears the
 * Important pill (the AI hand-off), as for {@link insightBadge}.
 *
 * - stripe: the attention reason (ai_handoff when Important and more
 *   severe), else urgent priority, else a hot or ready lead, else none.
 * - chips, most telling first, at most three: the attention reason, or
 *   else the mood (wants a person › upset › very negative); the lead band
 *   when warm, hot or ready; the intent when known and not small talk or
 *   unclear.
 */
export function rowSignals(
  row: SignalRow,
  opts: { important?: boolean } = {}
): RowSignals {
  const attention = rowAttention(row, opts.important ?? false);
  const lead = leadBand(row.insight_lead_temp);
  const intent = insightSummary(row).intent;

  let stripe: PaletteRef | null = null;
  if (attention) stripe = { family: 'attention', key: attention.reason };
  else if ((row.insight_priority ?? 0) >= PRIORITY_URGENT)
    stripe = { family: 'urgency', key: 'urgent' };
  else if (lead === 'hot' || lead === 'ready')
    stripe = { family: 'lead', key: lead };

  const chips: PaletteRef[] = [];
  if (attention) chips.push({ family: 'attention', key: attention.reason });
  else if (wantsPerson(row.insight_wants_human))
    chips.push({ family: 'attention', key: 'wants_person' });
  else if (isUpset(row.insight_upset))
    chips.push({ family: 'attention', key: 'upset' });
  else if (sentimentBand(row.insight_sentiment) === 'very_negative')
    chips.push({ family: 'sentiment', key: 'very_negative' });
  if (lead === 'warm' || lead === 'hot' || lead === 'ready')
    chips.push({ family: 'lead', key: lead });
  if (intent && !QUIET_INTENTS.has(intent))
    chips.push({ family: 'intent', key: intent });

  return { stripe, chips: chips.slice(0, ROW_CHIP_LIMIT), attention };
}

// ---------------------------------------------------------------------------
// Pinned until handled (migration 153)
// ---------------------------------------------------------------------------

type PinRow = Pick<
  Conversation,
  | 'id'
  | 'last_message_at'
  | 'ai_attention_at'
  | 'insight_attention_at'
  | 'insight_attention_reason'
>;

/**
 * Whether the chat is pinned at the top of the Inbox: a signal asked for
 * a person (`insight_attention_at`, until a person replies, clicks
 * Handled or closes it) or the AI handed it over (Important).
 */
export function isPinned(
  row: Pick<Conversation, 'ai_attention_at' | 'insight_attention_at'>
): boolean {
  return stamp(row.insight_attention_at) !== null || needsAttention(row);
}

/** A pinned row's severity rank (0 most severe) and its waiting time. */
function pinKey(row: PinRow): { rank: number; since: number | null } | null {
  if (!isPinned(row)) return null;
  const attention = rowAttention(row, needsAttention(row));
  // A stamp with a reason this build does not know: pinned, after every
  // known reason.
  if (!attention)
    return { rank: SEVERITY.length, since: stamp(row.insight_attention_at) };
  return {
    rank: SEVERITY.indexOf(attention.reason),
    since: stamp(attention.since),
  };
}

/**
 * The order among pinned chats: severity (urgent › ai_handoff ›
 * wants_person › upset › callback), then the longest waiting first
 * (earliest attention time; a missing time last), then the newest
 * message, then `id DESC`. Pinned rows sort before unpinned ones; two
 * unpinned rows compare equal, so a stable sort keeps their order.
 */
export function comparePinned(a: PinRow, b: PinRow): number {
  const ak = pinKey(a);
  const bk = pinKey(b);
  if (!ak || !bk) return ak ? -1 : bk ? 1 : 0;
  if (ak.rank !== bk.rank) return ak.rank - bk.rank;
  if (ak.since !== bk.since) {
    if (ak.since === null) return 1;
    if (bk.since === null) return -1;
    return ak.since - bk.since;
  }
  const aAt = stamp(a.last_message_at);
  const bAt = stamp(b.last_message_at);
  if (aAt !== bAt) {
    if (aAt === null) return 1;
    if (bAt === null) return -1;
    return bAt - aAt;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The list in display order: pinned chats first in
 * {@link comparePinned} order, then the rest in today's order (newest
 * message first, `compareForInbox`). Returns a copy.
 */
export function sortWithPins<T extends PinRow>(rows: readonly T[]): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (isPinned(r) ? pinned : rest).push(r);
  return [...pinned.sort(comparePinned), ...rest.sort(compareForInbox)];
}

// ---------------------------------------------------------------------------
// Handled, the Pinned chip and live pin changes (the Inbox list)
// ---------------------------------------------------------------------------

/**
 * Whether the chat carries a signal's attention stamp, which Handled
 * (`acknowledge_insight_attention`) clears. Important alone does not:
 * Take over / Resume / a reply clear that one.
 */
export function hasAttentionPin(
  row: Pick<Conversation, 'insight_attention_at'>
): boolean {
  return stamp(row.insight_attention_at) !== null;
}

/**
 * Chats marked Handled whose RPC has not come back through realtime yet:
 * conversation id → the attention stamp that was handled. A row still
 * holding that exact stamp is shown cleared (in the list, unpinned); a
 * newer stamp (a fresh signal since) shows again, and deleting the entry
 * (the RPC failed) restores the pin. Rows not named are returned as-is,
 * and so is the array when nothing changed.
 */
export function applyHandled<
  T extends Pick<
    Conversation,
    'id' | 'insight_attention_at' | 'insight_attention_reason'
  >,
>(rows: T[], handled: ReadonlyMap<string, string>): T[] {
  if (handled.size === 0) return rows;
  let changed = false;
  const out = rows.map((r) => {
    const at = handled.get(r.id);
    if (at === undefined || r.insight_attention_at !== at) return r;
    changed = true;
    return { ...r, insight_attention_at: null, insight_attention_reason: null };
  });
  return changed ? out : rows;
}

/** The header's "N pinned" chip: how many, and whether any is urgent. */
export function pinnedSummary(
  rows: readonly Pick<
    Conversation,
    'ai_attention_at' | 'insight_attention_at' | 'insight_attention_reason'
  >[]
): { count: number; urgent: boolean } {
  let count = 0;
  let urgent = false;
  for (const r of rows) {
    if (!isPinned(r)) continue;
    count++;
    if (storedAttention(r)?.reason === 'urgent') urgent = true;
  }
  return { count, urgent };
}

/**
 * Whether a realtime conversation update for a chat the list has not
 * loaded should fetch it: it was just pinned by a signal, so it belongs
 * at the top whatever its last message's age. Only with signals on;
 * off, the list behaves exactly as before.
 */
export function shouldFetchUnloadedPin(
  row: Pick<Conversation, 'insight_attention_at'>,
  signalsEnabled: boolean
): boolean {
  return signalsEnabled && hasAttentionPin(row);
}

// ---------------------------------------------------------------------------
// Row layout, labels, narrowing and the home tile (review round 2)
// ---------------------------------------------------------------------------

/**
 * Whether a row gets its third, quiet line. Chips never earn it: they
 * ride on the preview line (the preview truncates to make room), so a
 * row is the same height with or without signals. `chips` is accepted
 * only so a caller cannot mistake it for a reason.
 */
export function rowHasMetaLine(input: {
  numberName?: string | null;
  campaignName?: string | null;
  sharedBank?: string | null;
  showAssignee?: boolean;
  chips?: readonly unknown[];
  /** The personal-chat badge (migration 191). */
  personalLabel?: string | null;
}): boolean {
  return (
    !!input.personalLabel ||
    !!input.numberName ||
    !!input.campaignName ||
    !!input.sharedBank ||
    !!input.showAssignee
  );
}

/** A stored attention reason the row can name (never `ai_handoff`). */
export type StoredAttentionKey = Exclude<AttentionKey, 'ai_handoff'>;

/**
 * What a pinned row's label names: the signal's stored reason (if any)
 * and whether it is also Important (the AI hand-off). A chat that is
 * both names both ("Urgent · Important"), whichever is more severe;
 * before, Important hid the other reason.
 */
export function rowPinLabel(
  row: Pick<
    Conversation,
    'insight_attention_at' | 'insight_attention_reason' | 'ai_attention_at'
  >
): { reason: StoredAttentionKey | null; important: boolean } {
  const stored = storedAttention(row);
  return {
    reason: stored ? (stored.reason as StoredAttentionKey) : null,
    important: needsAttention(row),
  };
}

/**
 * Whether a row belongs in this list's personal narrowing: always with
 * none (an admin's Inbox, every Team inbox), else by
 * `inRestrictedInbox` — the same rule the list's query applies. Rows the
 * page hydrates outside a page fetch (a pin, Important, a missed
 * INSERT) pass this before they enter the list, or a team leader's
 * personal Inbox shows teammates' pinned chats.
 */
export function inPersonalInbox(
  row: RestrictableRow & PersonalChatRow,
  narrowing: InboxNarrowing | null,
  hideOthersPersonalFor?: string | null
): boolean {
  // /inbox (any role) never lists someone else's personal chat (191);
  // `undefined` is the Team inbox, which lists all RLS returns.
  if (
    hideOthersPersonalFor !== undefined &&
    isOthersPersonalChat(row, hideOthersPersonalFor)
  )
    return false;
  if (!narrowing) return true;
  return inRestrictedInbox(
    row,
    narrowing.userId,
    narrowing.channelIds,
    narrowing.sharedConversationIds
  );
}

/**
 * Whether a conversation a realtime INSERT announced goes into the list
 * now: not one the list already holds, and inside the personal
 * narrowing. RLS streams a team leader every new chat of their team, so
 * without the narrowing a teammate's new chat appeared in the leader's
 * personal Inbox, and stayed there: the hydrate that follows keeps a row
 * already in the list. The INSERT payload carries every column
 * `inRestrictedInbox` reads.
 */
export function admitsInsertedConversation(
  row: RestrictableRow & PersonalChatRow,
  knownIds: ReadonlySet<string>,
  narrowing: InboxNarrowing | null,
  hideOthersPersonalFor?: string | null
): boolean {
  return (
    !knownIds.has(row.id) &&
    inPersonalInbox(row, narrowing, hideOthersPersonalFor)
  );
}

/** The columns the Pinned chats tile reads. */
export const PIN_TILE_COLUMNS =
  'id, last_message_at, ai_attention_at, insight_attention_at, insight_attention_reason, campaign_broadcast_id, human_engaged_at, assigned_agent_id, ai_autoreply_disabled, ai_reply_count, chat_tag_id';

/** The tile's read as an `or` group: anything {@link isPinned} could pin. */
export const PIN_TILE_OR =
  'insight_attention_at.not.is.null,ai_attention_at.not.is.null';

type PinTileRow = CampaignInboxFields &
  Pick<
    Conversation,
    | 'last_message_at'
    | 'ai_attention_at'
    | 'insight_attention_at'
    | 'insight_attention_reason'
  >;

/**
 * The home "Pinned chats" tile, counted as the list it opens counts its
 * "N pinned" chip ({@link pinnedSummary}): pinned by a signal OR
 * Important, among chats the Inbox lists (holding a message, not in the
 * Campaign inbox). No personal narrowing: the tile links each role to an
 * un-narrowed list (`inboxHrefFor` — a team leader to the Team inbox).
 */
export function countPinnedTile(
  rows: readonly PinTileRow[],
  aiLive: boolean
): { pinned: number; urgent: number } {
  let pinned = 0;
  let urgent = 0;
  for (const r of rows) {
    if (!hasMessages(r) || inCampaignInbox(r, aiLive) || !isPinned(r)) continue;
    pinned++;
    if (storedAttention(r)?.reason === 'urgent') urgent++;
  }
  return { pinned, urgent };
}
