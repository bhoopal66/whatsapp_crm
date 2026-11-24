// Pure folding of the aggregated rows the dashboard RPCs return
// (migration 058) into the shapes the chart components consume.
// Kept free of I/O so the bucketing rules stay unit-testable.

import type {
  ConversationsSeriesPoint,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types';

/** Row of `dashboard_message_series`. `day` is a local `YYYY-MM-DD`. */
export interface MessageSeriesRow {
  day: string;
  incoming: number | string;
  outgoing: number | string;
}

/**
 * Seed every day key with zeros (so quiet days still plot a 0-point)
 * and fill in the days the RPC returned. Days outside `keys` are
 * dropped, exactly as the old client-side bucketing did.
 */
export function foldMessageSeries(
  keys: string[],
  rows: MessageSeriesRow[]
): ConversationsSeriesPoint[] {
  const byDay = new Map<string, { incoming: number; outgoing: number }>();
  for (const r of rows) {
    byDay.set(r.day, {
      incoming: Number(r.incoming) || 0,
      outgoing: Number(r.outgoing) || 0,
    });
  }
  return keys.map((day) => ({
    day,
    ...(byDay.get(day) ?? { incoming: 0, outgoing: 0 }),
  }));
}

/** Row of `dashboard_response_time`. */
export interface ResponseTimeRow {
  /** 0 = Mon … 6 = Sun. */
  dow: number;
  period: 'this_week' | 'last_week' | 'earlier' | string;
  samples: number | string;
  total_minutes: number | string | null;
}

/**
 * Per-weekday averages over the whole window (so each bar has more
 * samples to stand on), plus this-week / last-week headline averages.
 * A weekday or week with no samples averages to null.
 */
export function foldResponseTime(rows: ResponseTimeRow[]): ResponseTimeSummary {
  const dowSum = Array.from({ length: 7 }, () => ({ n: 0, total: 0 }));
  const week = {
    this_week: { n: 0, total: 0 },
    last_week: { n: 0, total: 0 },
  };

  for (const r of rows) {
    const n = Number(r.samples) || 0;
    const total = Number(r.total_minutes) || 0;
    const slot = dowSum[r.dow];
    if (slot) {
      slot.n += n;
      slot.total += total;
    }
    if (r.period === 'this_week' || r.period === 'last_week') {
      week[r.period].n += n;
      week[r.period].total += total;
    }
  }

  const avg = (s: { n: number; total: number }) =>
    s.n === 0 ? null : s.total / s.n;

  const buckets: ResponseTimeBucket[] = dowSum.map((s, dow) => ({
    dow,
    avgMinutes: avg(s),
    samples: s.n,
  }));

  return {
    buckets,
    thisWeekAvg: avg(week.this_week),
    lastWeekAvg: avg(week.last_week),
  };
}

/** Row of `dashboard_open_deal_values` (296): one per stage and currency. */
export interface OpenDealValueRow {
  stage_id: string;
  currency: string;
  deal_count: number | string;
  total_value: number | string | null;
}

/**
 * Stage slices for the donut, in stage order, each with its value per
 * currency. Empty stages are hidden from the ring — trimming keeps the
 * visual clean for the common case.
 */
export function foldPipelineSlices(
  stages: { id: string; name: string; color: string | null }[],
  rows: OpenDealValueRow[]
): PipelineStageSlice[] {
  const byStage = new Map<string, OpenDealValueRow[]>();
  for (const r of rows) {
    const list = byStage.get(r.stage_id);
    if (list) list.push(r);
    else byStage.set(r.stage_id, [r]);
  }
  return stages
    .map((s) => {
      const own = byStage.get(s.id) ?? [];
      return {
        id: s.id,
        name: s.name,
        color: s.color || '#64748b',
        dealCount: own.reduce((n, r) => n + (Number(r.deal_count) || 0), 0),
        totals: own.map((r) => ({
          currency: r.currency,
          value: Number(r.total_value) || 0,
        })),
      };
    })
    .filter((s) => s.dealCount > 0);
}
