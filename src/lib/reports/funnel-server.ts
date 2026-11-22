// ============================================================
// The Funnel report's server half, shared by GET /api/reports/funnel
// and its CSV export (route files may export only handlers). Owners
// and admins only: the routes call requireRole('admin') first, and
// funnel_report (254) refuses anyone else with HINT NOT_ALLOWED.
//
// The range is computed exactly as the Team activity route does it: in
// the account's saved zone (team_activity_limits), else the viewer's,
// else UTC, so "today" is the same day on both pages.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  parseFunnelFilters,
  parseFunnelReport,
  type FunnelFilters,
  type FunnelReport,
} from '@/lib/reports/funnel';
import { isMissingFunction } from '@/lib/team-activity/db-errors';
import { isValidTimeZone, limitsFromRow } from '@/lib/team-activity/limits';
import { rangeFor, type RangePreset } from '@/lib/team-activity/range';

export const FUNNEL_NOT_MIGRATED_MESSAGE =
  'The funnel report needs database migration 254.';

export interface FunnelRange {
  preset: RangePreset;
  from: string;
  to: string;
  tz: string;
}

export type FunnelLoad =
  | {
      ok: true;
      report: FunnelReport;
      range: FunnelRange;
      filters: FunnelFilters;
    }
  | { ok: false; response: NextResponse };

const fail = (error: string, status: number): FunnelLoad => ({
  ok: false,
  response: NextResponse.json({ error }, { status }),
});

function hintOf(error: unknown): unknown {
  return error && typeof error === 'object' && 'hint' in error
    ? (error as { hint: unknown }).hint
    : null;
}

/** Validate the query, compute the range and run funnel_report. */
export async function loadFunnelReport(
  supabase: SupabaseClient,
  accountId: string,
  params: URLSearchParams
): Promise<FunnelLoad> {
  const parsed = parseFunnelFilters(params);
  if (!parsed.ok) {
    return fail(
      parsed.field === 'range' ? 'Unknown range' : `Unknown ${parsed.field}`,
      400
    );
  }
  const { filters } = parsed;

  const { data: limitRows, error: limitsError } = await supabase.rpc(
    'team_activity_limits',
    { p_account: accountId }
  );
  if (limitsError) {
    if (isMissingFunction(limitsError)) {
      return fail(FUNNEL_NOT_MIGRATED_MESSAGE, 503);
    }
    console.error('[funnel-report] limits failed:', limitsError.message);
    return fail('Failed to load the funnel report', 500);
  }
  const saved = limitsFromRow(
    Array.isArray(limitRows) ? (limitRows[0] as Record<string, unknown>) : null
  );
  const viewerZone = filters.tz;
  const tz =
    saved.timezone ??
    (viewerZone && isValidTimeZone(viewerZone) ? viewerZone : 'UTC');

  const range = rangeFor(filters.range, new Date(), tz);
  // A request landing on the very millisecond of midnight.
  if (range.to.getTime() <= range.from.getTime()) {
    range.to = new Date(range.from.getTime() + 1000);
  }

  const { data, error } = await supabase.rpc('funnel_report', {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_tz: tz,
    p_lead_source: filters.leadSource,
    p_agent: filters.agent,
    p_bank: filters.bank,
    p_channel: filters.channel,
  });
  if (error) {
    if (isMissingFunction(error)) return fail(FUNNEL_NOT_MIGRATED_MESSAGE, 503);
    const hint = hintOf(error);
    if (hint === 'NOT_ALLOWED') return fail('Owners and admins only', 403);
    if (hint === 'BAD_RANGE') return fail('The period is not valid', 400);
    if (hint === 'BAD_FILTER') return fail('Unknown filter', 400);
    console.error('[funnel-report] report failed:', error.message);
    return fail('Failed to load the funnel report', 500);
  }

  return {
    ok: true,
    report: parseFunnelReport(data),
    range: {
      preset: filters.range,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      tz,
    },
    filters,
  };
}
