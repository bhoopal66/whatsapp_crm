import type { AiReplyTier, AiRouteSource } from './outcomes';

// ============================================================
// AI activity summary (Settings → AI Agents → Overview, migration 077).
//
// `GET /api/ai/activity` fetches a bounded window of `ai_reply_events`
// and `ai_usage_log` (auto-reply calls only) and hands both here; the
// route does no arithmetic of its own, so everything the card shows is
// pinned by activity.test.ts.
// ============================================================

/** Default and bounds of the `?days=` window. */
export const AI_ACTIVITY_DEFAULT_DAYS = 7;
export const AI_ACTIVITY_MAX_DAYS = 90;

/** `ai_reply_events` columns the summary reads. */
export interface AiReplyEventRow {
  outcome: string;
  tier: AiReplyTier | null;
  model: string | null;
  route_source: AiRouteSource | null;
  escalated: boolean | null;
}

/** `ai_usage_log` columns the summary reads. */
export interface AiUsageLogRow {
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface AiActivityTier {
  tier: AiReplyTier;
  /** Replies sent on this tier. */
  replies: number;
  /** The model that sent most of them (newest wins a tie); null if none. */
  model: string | null;
}

export interface AiActivitySummary {
  /** Every dispatch in the window. */
  total: number;
  replied: number;
  handed_off: number;
  held_for_review: number;
  /** Every other outcome: the skips and errors. */
  not_replied: number;
  /** Count per outcome code, every code seen. */
  by_outcome: Record<string, number>;
  /** Why the bot did not reply, most frequent first. */
  not_replied_reasons: { outcome: string; count: number }[];
  /** Replies per tier, always small → standard → large. */
  tiers: AiActivityTier[];
  /**
   * What picked the tier, over the dispatches that recorded one.
   * `share` is a 0..1 fraction of `routed`; all zero when nothing routed.
   */
  routing: {
    routed: number;
    counts: Record<AiRouteSource, number>;
    share: Record<AiRouteSource, number>;
  };
  /** Dispatches flagged `escalated` (moved up from the tier first picked). */
  escalated: number;
  /** Auto-reply token spend per model, largest first. */
  tokens_by_model: {
    model: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }[];
}

/** The outcomes the headline counts as "the bot acted". */
const ACTED = new Set(['replied', 'handed_off', 'held_for_review']);

const TIERS: readonly AiReplyTier[] = ['small', 'standard', 'large'];
const ROUTE_SOURCES: readonly AiRouteSource[] = ['jev', 'heuristic', 'fixed'];

/**
 * `?days=` → a whole number of days in 1..90. Missing or unparseable
 * falls back to the default; out-of-range values clamp.
 */
export function parseActivityDays(raw: string | null): number {
  if (raw === null || raw.trim() === '') return AI_ACTIVITY_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return AI_ACTIVITY_DEFAULT_DAYS;
  return Math.min(AI_ACTIVITY_MAX_DAYS, Math.max(1, Math.floor(n)));
}

/** The most frequent key; the first seen wins a tie (rows are newest first). */
function mostFrequent(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Aggregate one window of bot dispatches and auto-reply token spend.
 * `events` and `usage` are expected newest first, as the route reads
 * them. A reply with no recorded tier counts as `standard`: that is the
 * config's own model, which is what the bot used before tiers existed.
 */
export function summarizeAiActivity(
  events: readonly AiReplyEventRow[],
  usage: readonly AiUsageLogRow[]
): AiActivitySummary {
  const byOutcome: Record<string, number> = {};
  const tierReplies = new Map<AiReplyTier, number>();
  const tierModels = new Map<AiReplyTier, Map<string, number>>();
  const routeCounts: Record<AiRouteSource, number> = {
    jev: 0,
    heuristic: 0,
    fixed: 0,
  };
  let escalated = 0;

  for (const e of events) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    if (e.escalated === true) escalated += 1;
    if (e.route_source && e.route_source in routeCounts) {
      routeCounts[e.route_source] += 1;
    }
    if (e.outcome === 'replied') {
      const tier: AiReplyTier =
        e.tier && TIERS.includes(e.tier) ? e.tier : 'standard';
      tierReplies.set(tier, (tierReplies.get(tier) ?? 0) + 1);
      if (e.model) {
        const models = tierModels.get(tier) ?? new Map<string, number>();
        models.set(e.model, (models.get(e.model) ?? 0) + 1);
        tierModels.set(tier, models);
      }
    }
  }

  const notReplied = Object.entries(byOutcome)
    .filter(([outcome]) => !ACTED.has(outcome))
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);

  const routed = ROUTE_SOURCES.reduce((sum, s) => sum + routeCounts[s], 0);
  const share = Object.fromEntries(
    ROUTE_SOURCES.map((s) => [s, routed ? routeCounts[s] / routed : 0])
  ) as Record<AiRouteSource, number>;

  const tokens = new Map<
    string,
    AiActivitySummary['tokens_by_model'][number]
  >();
  for (const u of usage) {
    const row = tokens.get(u.model) ?? {
      model: u.model,
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    row.calls += 1;
    row.prompt_tokens += u.prompt_tokens ?? 0;
    row.completion_tokens += u.completion_tokens ?? 0;
    row.total_tokens += u.total_tokens ?? 0;
    tokens.set(u.model, row);
  }

  return {
    total: events.length,
    replied: byOutcome.replied ?? 0,
    handed_off: byOutcome.handed_off ?? 0,
    held_for_review: byOutcome.held_for_review ?? 0,
    not_replied: notReplied.reduce((sum, r) => sum + r.count, 0),
    by_outcome: byOutcome,
    not_replied_reasons: notReplied,
    tiers: TIERS.map((tier) => ({
      tier,
      replies: tierReplies.get(tier) ?? 0,
      model: mostFrequent(tierModels.get(tier) ?? new Map()),
    })),
    routing: { routed, counts: routeCounts, share },
    escalated,
    tokens_by_model: [...tokens.values()].sort(
      (a, b) => b.total_tokens - a.total_tokens
    ),
  };
}
