import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { csvFileName, csvResponse } from '@/lib/csv/build';
import {
  foldMessageSeries,
  foldResponseTime,
  type MessageSeriesRow,
  type ResponseTimeRow,
} from '@/lib/dashboard/aggregate';
import {
  dashboardCsv,
  dashboardWindows,
  zonedDayKey,
  type DashboardFigures,
} from '@/lib/dashboard/export';
import {
  WEEK_MS,
  weekSummary,
  type CampaignRow,
} from '@/lib/dashboard/home/campaigns';
import { numberHealth, type NumberFields } from '@/lib/dashboard/home/numbers';
import { loadPipelineDonut } from '@/lib/dashboard/queries';
import { glanceOf } from '@/lib/team-activity/glance';
import { isValidTimeZone } from '@/lib/team-activity/limits';
import { loadTeamActivityReport } from '@/lib/team-activity/load-report';

/**
 * GET /api/dashboard/export?tz=<IANA zone>  → text/csv attachment
 *
 * Owner only (the owner's decision). The home screen's figures, read
 * here through the caller's RLS client with the same RPCs and folds
 * the cards use: team activity today, number health, campaigns,
 * messages over the last 30 days, open deals per stage and first
 * response times. Counts and averages only.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('owner');
    const zone = new URL(request.url).searchParams.get('tz');
    const tz = zone && isValidTimeZone(zone) ? zone : 'UTC';

    const figures = await loadFigures(supabase, accountId, tz, new Date());
    return csvResponse(dashboardCsv(figures), csvFileName('dashboard'));
  } catch (err) {
    if (err instanceof FigureError) {
      console.error('[dashboard-export] failed:', err.message);
      return NextResponse.json(
        { error: 'Failed to load the dashboard figures' },
        { status: 500 }
      );
    }
    return toErrorResponse(err);
  }
}

class FigureError extends Error {}

function check<T>(res: { data: T; error: unknown }, what: string): T {
  if (res.error) {
    const msg =
      res.error && typeof res.error === 'object' && 'message' in res.error
        ? String((res.error as { message: unknown }).message)
        : 'unknown error';
    throw new FigureError(`${what}: ${msg}`);
  }
  return res.data;
}

async function loadFigures(
  supabase: SupabaseClient,
  accountId: string,
  tz: string,
  now: Date
): Promise<DashboardFigures> {
  const w = dashboardWindows(now, tz);
  const since = new Date(now.getTime() - WEEK_MS).toISOString();

  const [series, response, pipeline, inFlight, sent, numbers, team] =
    await Promise.all([
      supabase.rpc('dashboard_message_series', {
        p_since: w.messagesSince.toISOString(),
        p_tz: tz,
      }),
      supabase.rpc('dashboard_response_time', {
        p_since: w.responseSince.toISOString(),
        p_tz: tz,
        p_this_week_start: w.thisWeekStart.toISOString(),
        p_last_week_start: w.lastWeekStart.toISOString(),
      }),
      loadPipelineDonut(supabase).catch((err: unknown) => {
        throw new FigureError(
          `pipeline: ${err instanceof Error ? err.message : String(err)}`
        );
      }),
      supabase
        .from('broadcasts')
        .select('id', { count: 'exact', head: true })
        .in('status', ['sending', 'scheduled']),
      supabase
        .from('broadcasts')
        .select('sent_count, delivered_count, read_count')
        .eq('status', 'sent')
        // As the Campaigns card: a scheduled campaign's send day is
        // `scheduled_at`, created_at covers the rest.
        .or(
          `scheduled_at.gte.${since},and(scheduled_at.is.null,created_at.gte.${since})`
        ),
      supabase
        .from('whatsapp_config')
        .select('id, provider, label, waba_id, is_primary, status')
        .eq('account_id', accountId),
      // The Team card's "today"; left out of the file if it cannot load.
      loadTeamActivityReport(
        supabase,
        accountId,
        { preset: 'today', channel: null, viewerZone: tz },
        now
      ).catch(() => null),
    ]);

  const seriesRows = check(series, 'message series') as
    MessageSeriesRow[] | null;
  const responseRows = check(response, 'response time') as
    ResponseTimeRow[] | null;
  check(inFlight, 'campaigns in flight');
  const sentRows = check(sent, 'campaigns sent') as CampaignRow[] | null;
  const numberRows = check(numbers, 'numbers') as NumberFields[] | null;
  const health = numberHealth(numberRows ?? []);

  return {
    tz,
    today: zonedDayKey(now, tz),
    messages: foldMessageSeries(w.messageDays, seriesRows ?? []),
    responseTime: foldResponseTime(responseRows ?? []),
    pipeline: pipeline.stages,
    campaigns: {
      week: weekSummary(sentRows ?? []),
      inFlight: inFlight.count ?? 0,
    },
    numbers: {
      total: health.total,
      connected: health.connected,
      disconnected: health.disconnected,
      unknown: health.unknown,
    },
    team: team && team.kind === 'ok' ? glanceOf(team.report) : null,
  };
}
