/**
 * Smart insights trends (docs/jev-insights.md): which way a chat's mood
 * and lead temperature are moving, from `conversation_insight_events`
 * (one row per judged customer message, migration 153).
 *
 * Dependency-free — no imports at all — because client components
 * import it.
 */

/** One judged message, as GET /api/insights/conversations/[id]/history
 *  returns it. `figures` uses the camelCase keys (`sentiment` 0..4,
 *  `leadTemp` 0..3, …). */
export interface InsightEvent {
  at: string;
  figures: Record<string, unknown> | null;
}

export type MoodTrend = 'improving' | 'steady' | 'worsening';
export type LeadTrend = 'warming' | 'steady' | 'cooling';

export interface TrendPoint {
  at: string;
  sentiment: number | null;
  leadTemp: number | null;
}

export interface InsightTrends {
  /** null: fewer than {@link TREND_MIN_POINTS} messages with a sentiment. */
  mood: MoodTrend | null;
  /** null: fewer than {@link TREND_MIN_POINTS} messages with a lead temperature. */
  lead: LeadTrend | null;
  /** Oldest → newest, at most {@link TREND_SERIES_MAX} points. */
  series: TrendPoint[];
}

/** Points compared on each side: the newest this many against the this
 *  many before them. */
export const TREND_WINDOW = 3;
/** Fewer values than this and there is no trend. */
export const TREND_MIN_POINTS = 4;
/** Points the sparkline keeps. */
export const TREND_SERIES_MAX = 12;

// How far the newer mean must move from the older one to count as a
// change. UNCALIBRATED: a tenth of the sentiment scale (0..4) and a bit
// more of the lead scale (0..3), not fitted to reviewed conversations.
/** Sentiment change (0..4 scale) at or above which the mood moved. */
export const MOOD_CHANGE_MIN = 0.4;
/** Lead-temperature change (0..3 scale) at or above which the lead moved. */
export const LEAD_CHANGE_MIN = 0.4;

// Means of a few reals are inexact (2.4 - 2.0 is 0.3999…); a delta this
// close to the threshold counts as reaching it.
const EPSILON = 1e-9;

const num = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** -1, 0 or 1: the newest {@link TREND_WINDOW} values' mean against the
 *  up-to-{@link TREND_WINDOW} before them; null with too few values. */
function direction(values: number[], min: number): -1 | 0 | 1 | null {
  if (values.length < TREND_MIN_POINTS) return null;
  const newer = values.slice(-TREND_WINDOW);
  const older = values.slice(-2 * TREND_WINDOW, -TREND_WINDOW);
  const delta = mean(newer) - mean(older);
  if (delta >= min - EPSILON) return 1;
  if (delta <= -min + EPSILON) return -1;
  return 0;
}

/**
 * The trends of a chat's judged messages, in any order. An event whose
 * `at` does not parse is dropped; a missing or non-numeric figure is
 * skipped for that scale only (the point stays in the series as null).
 */
export function insightTrends(
  events: readonly InsightEvent[] | null | undefined
): InsightTrends {
  const points = (events ?? [])
    .map((e) => ({ e, t: Date.parse(e.at) }))
    .filter(({ t }) => Number.isFinite(t))
    .sort((a, b) => a.t - b.t)
    .map(({ e }): TrendPoint => ({
      at: e.at,
      sentiment: num(e.figures?.sentiment),
      leadTemp: num(e.figures?.leadTemp),
    }));

  const sentiments = points.flatMap((p) => p.sentiment ?? []);
  const leads = points.flatMap((p) => p.leadTemp ?? []);
  const mood = direction(sentiments, MOOD_CHANGE_MIN);
  const lead = direction(leads, LEAD_CHANGE_MIN);

  return {
    mood:
      mood === null
        ? null
        : mood > 0
          ? 'improving'
          : mood < 0
            ? 'worsening'
            : 'steady',
    lead:
      lead === null
        ? null
        : lead > 0
          ? 'warming'
          : lead < 0
            ? 'cooling'
            : 'steady',
    series: points.slice(-TREND_SERIES_MAX),
  };
}
