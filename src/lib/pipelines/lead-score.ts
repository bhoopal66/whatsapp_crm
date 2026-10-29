import { isUpset, leadBand, urgencyBand } from '@/lib/insights/bands';

/**
 * The lead score on a Pipelines deal card (docs/jev-insights.md, "Lead
 * score"): one 0..100 figure per open deal, from what Jev last judged
 * about the customer's chat, how recently the chat moved, whether the
 * customer is waiting on us and how far along the pipeline the deal is.
 *
 * Pure and client-safe (bands.ts only), so the board computes it in the
 * browser from figures RLS already let it read. It is a GUIDE: every
 * weight and threshold below is UNCALIBRATED — a first judgment, not
 * fitted to won and lost deals. Change them here, in one place.
 */

type Figure = number | null | undefined;

const known = (x: Figure): x is number =>
  typeof x === 'number' && Number.isFinite(x);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// Weights (points out of 100 when every factor is known). Uncalibrated.
/** Jev's lead temperature (0..3). */
export const WEIGHT_LEAD_TEMP = 40;
/** The chat's last message, decaying to nothing over ACTIVITY_DECAY_DAYS. */
export const WEIGHT_ACTIVITY = 20;
/** Jev's urgency (0..2). */
export const WEIGHT_URGENCY = 15;
/** How far along its pipeline's stages the deal sits. */
export const WEIGHT_STAGE = 15;
/** The customer has unread messages: waiting on a reply from us. */
export const WEIGHT_WAITING = 10;

/** Days over which recent activity decays linearly to zero. */
export const ACTIVITY_DECAY_DAYS = 14;
/** Activity at or above this share counts as "active recently" (≤ 7 days). */
export const ACTIVE_RECENTLY_MIN = 0.5;
/** Days of silence after which an open deal is at risk. */
export const QUIET_DAYS = 14;
/** Stage progress at or above which a deal is "late stage". */
export const LATE_STAGE_MIN = 0.6;

/** Score bands. Uncalibrated. */
export const HOT_SCORE_MIN = 70;
export const WARM_SCORE_MIN = 40;

/** Most reasons a score carries. */
export const MAX_REASONS = 3;

const DAY_MS = 86_400_000;

export type LeadScoreBand = 'hot' | 'warm' | 'cold';

export type LeadScoreReason =
  | 'upset'
  | 'quiet_14d'
  | 'ready_to_apply'
  | 'hot_lead'
  | 'urgent'
  | 'soon'
  | 'active_recently'
  | 'waiting_on_us'
  | 'late_stage';

export interface LeadScore {
  score: number;
  band: LeadScoreBand;
  /** 'activity' when Jev has judged nothing about the chat yet. */
  basis: 'insights' | 'activity';
  /** At most MAX_REASONS, most important first (risks lead). */
  reasons: LeadScoreReason[];
  atRisk: boolean;
}

export interface LeadScoreInput {
  /** The deal's status; won and lost deals get no score. */
  status?: 'open' | 'won' | 'lost' | null;
  /** When the deal was created (ISO). */
  dealCreatedAt: string;
  /** 0..1: the deal's stage among its pipeline's stages (stageProgress). */
  stageProgress: number;
  /** The contact's conversation, or null when it has none. */
  conversation: {
    insight_lead_temp?: Figure;
    insight_urgency?: Figure;
    insight_upset?: Figure;
    last_message_at?: string | null;
    unread_count?: number | null;
  } | null;
  /** Epoch ms; passed in so the score is deterministic. */
  now: number;
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

/** 0..1 position of a stage among its pipeline's stages, by `position`. */
export function stageProgress(
  stageId: string,
  stages: readonly { id: string; position: number }[]
): number {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const i = sorted.findIndex((s) => s.id === stageId);
  if (i < 0 || sorted.length < 2) return 0;
  return i / (sorted.length - 1);
}

export function scoreBand(score: number): LeadScoreBand {
  if (score >= HOT_SCORE_MIN) return 'hot';
  if (score >= WARM_SCORE_MIN) return 'warm';
  return 'cold';
}

/**
 * The deal's lead score, or null for a won or lost deal. Each factor is
 * a 0..1 value times its weight; the total is rescaled over the weights
 * of the factors that are known, so a chat Jev never judged is scored
 * on activity, waiting and stage alone (`basis: 'activity'`).
 */
export function leadScore(input: LeadScoreInput): LeadScore | null {
  if (input.status === 'won' || input.status === 'lost') return null;
  const c = input.conversation;

  const lastAt = time(c?.last_message_at);
  const activity =
    lastAt === null
      ? 0
      : clamp01(1 - (input.now - lastAt) / (ACTIVITY_DECAY_DAYS * DAY_MS));
  const waiting = (c?.unread_count ?? 0) > 0 ? 1 : 0;
  const stage = clamp01(input.stageProgress);

  const factors: { weight: number; value: number }[] = [
    { weight: WEIGHT_ACTIVITY, value: activity },
    { weight: WEIGHT_WAITING, value: waiting },
    { weight: WEIGHT_STAGE, value: stage },
  ];
  const leadTemp = c?.insight_lead_temp;
  const urgency = c?.insight_urgency;
  if (known(leadTemp))
    factors.push({ weight: WEIGHT_LEAD_TEMP, value: clamp01(leadTemp / 3) });
  if (known(urgency))
    factors.push({ weight: WEIGHT_URGENCY, value: clamp01(urgency / 2) });
  const basis = known(leadTemp) || known(urgency) ? 'insights' : 'activity';

  const total = factors.reduce((s, f) => s + f.weight, 0);
  const earned = factors.reduce((s, f) => s + f.weight * f.value, 0);
  const score = Math.round((100 * earned) / total);

  // Silence counts from the later of the last message and the deal's
  // creation: a deal opened yesterday is not "quiet for two weeks".
  const createdAt = time(input.dealCreatedAt);
  const since = Math.max(lastAt ?? -Infinity, createdAt ?? -Infinity);
  const quiet =
    Number.isFinite(since) && input.now - since >= QUIET_DAYS * DAY_MS;
  const upset = isUpset(c?.insight_upset);

  // Positive reasons, ranked by the points they brought.
  const positive: { reason: LeadScoreReason; points: number }[] = [];
  const lead = leadBand(leadTemp);
  if (known(leadTemp) && lead === 'ready')
    positive.push({
      reason: 'ready_to_apply',
      points: WEIGHT_LEAD_TEMP * clamp01(leadTemp / 3),
    });
  else if (known(leadTemp) && lead === 'hot')
    positive.push({
      reason: 'hot_lead',
      points: WEIGHT_LEAD_TEMP * clamp01(leadTemp / 3),
    });
  const urg = urgencyBand(urgency);
  if (known(urgency) && (urg === 'urgent' || urg === 'soon'))
    positive.push({
      reason: urg === 'urgent' ? 'urgent' : 'soon',
      points: WEIGHT_URGENCY * clamp01(urgency / 2),
    });
  if (activity >= ACTIVE_RECENTLY_MIN)
    positive.push({
      reason: 'active_recently',
      points: WEIGHT_ACTIVITY * activity,
    });
  if (waiting)
    positive.push({ reason: 'waiting_on_us', points: WEIGHT_WAITING });
  if (stage >= LATE_STAGE_MIN)
    positive.push({ reason: 'late_stage', points: WEIGHT_STAGE * stage });
  positive.sort((a, b) => b.points - a.points);

  const risks: LeadScoreReason[] = [];
  if (upset) risks.push('upset');
  if (quiet) risks.push('quiet_14d');

  return {
    score,
    band: scoreBand(score),
    basis,
    reasons: [...risks, ...positive.map((p) => p.reason)].slice(0, MAX_REASONS),
    atRisk: upset || quiet,
  };
}

/** What `leadScore` reads from a conversation row. */
export type LeadScoreConversation = NonNullable<LeadScoreInput['conversation']>;

/**
 * Within one stage column: highest score first, unscored (closed) deals
 * last, ties keeping the board's own order (Array.prototype.sort is
 * stable).
 */
export function sortByLeadScore<T extends { id: string }>(
  deals: readonly T[],
  scores: ReadonlyMap<string, LeadScore | null>
): T[] {
  const of = (d: T) => scores.get(d.id)?.score ?? -1;
  return [...deals].sort((a, b) => of(b) - of(a));
}
