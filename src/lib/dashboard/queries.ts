import type { SupabaseClient } from '@supabase/supabase-js'
import { daysAgoStart, lastNDayKeys, mondayIndex } from './date-utils'
import {
  foldMessageSeries,
  foldPipelineSlices,
  foldResponseTime,
  type MessageSeriesRow,
  type OpenDealsByStageRow,
  type ResponseTimeRow,
} from './aggregate'
import type {
  ConversationsSeriesPoint,
  PipelineDonutData,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// RLS scopes every query to the signed-in user automatically, so we
// never pass user_id explicitly here. The heavy aggregations (message
// series, response time, open deals) run as SECURITY INVOKER RPCs
// (migration 058) that return a few aggregated rows: downloading the
// raw rows was megabytes over the tunnel and silently truncated at
// PostgREST's max-rows cap. The pure folding lives in ./aggregate.
// ------------------------------------------------------------

/** The viewer's IANA zone, so SQL buckets by the same local day the
 *  browser's `daysAgoStart` boundaries were computed in. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

type DB = SupabaseClient

/** The open-deals-by-stage RPC's settled result. */
export type OpenDealsResult = { data: unknown; error: unknown }

/**
 * Open deals per stage, under the viewer's RLS. Settled here rather than
 * handed back as a builder: a Supabase builder re-sends its request
 * every time it is awaited.
 */
export async function fetchOpenDeals(db: DB): Promise<OpenDealsResult> {
  return await db.rpc('dashboard_open_deals_by_stage')
}

// --- Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString()
  const { data, error } = await db.rpc('dashboard_message_series', {
    p_since: start,
    p_tz: browserTimeZone(),
  })
  if (error) throw error
  return foldMessageSeries(lastNDayKeys(rangeDays), (data ?? []) as MessageSeriesRow[])
}

// --- Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(
  db: DB,
  openDealsPromise: Promise<OpenDealsResult> = fetchOpenDeals(db),
): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('id, name, color, pipeline_id, position').order('position'),
    openDealsPromise,
  ])
  if (stagesRes.error) throw stagesRes.error
  if (dealsRes.error) throw dealsRes.error

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const slices = foldPipelineSlices(
    stages,
    (dealsRes.data ?? []) as OpenDealsByStageRow[],
  )

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- Response time by day of week ----------------------------------

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  // The last 14 days give us both "this week" + "last week" with
  // enough overlap if the user opens the dashboard late on a Monday.
  // The per-conversation pairing (first unanswered customer message →
  // next agent/bot message) runs in SQL; see migration 058.
  const now = new Date()
  const { data, error } = await db.rpc('dashboard_response_time', {
    p_since: daysAgoStart(13).toISOString(),
    p_tz: browserTimeZone(),
    p_this_week_start: daysAgoStart(mondayIndex(now)).toISOString(),
    p_last_week_start: daysAgoStart(mondayIndex(now) + 7).toISOString(),
  })
  if (error) throw error
  return foldResponseTime((data ?? []) as ResponseTimeRow[])
}
