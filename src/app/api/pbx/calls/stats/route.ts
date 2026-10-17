// ============================================================
// GET /api/pbx/calls/stats — the Call report page's figures
// (module 015, migration 119).
//   ?period=today|yesterday|week|last_week|month|last_month|custom
//    &from=YYYY-MM-DD&to=YYYY-MM-DD&tz=&user=<uuid>
//   → { stats: CallStats, range: { period, from, to, timeZone } }
//
// Viewer and up (a bank guest never: requireRole ranks them below
// viewer). The period is computed here, in the account's zone, as GET
// /api/pbx/calls/report does; a custom period is whole days, both
// inclusive, at most 92. pbx_call_stats decides whose calls the caller
// gets: owners and admins the workspace, a team leader their teams plus
// themselves, everyone else their own. `user` narrows to one person in
// that scope; anyone outside it is a 403. The previous period the deltas
// compare with is computed here too (callReportPreviousRange: like with
// like). SQL's 22023 (a zone or period it refuses) is a 400.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { UUID, fail } from '@/lib/pbx/calls';
import {
  CALL_REPORT_MAX_DAYS,
  callReportPreviousRange,
  callReportRange,
  isCallStatsPeriod,
  reportTimeZone,
} from '@/lib/pbx/call-report';
import { parseCallStats } from '@/lib/pbx/call-stats';
import { isMissingFunction } from '@/lib/team-activity/db-errors';

const PROBLEMS = {
  missing: 'A custom period needs from and to dates (YYYY-MM-DD)',
  order: 'The period ends before it starts',
  span: `A custom period spans at most ${CALL_REPORT_MAX_DAYS} days`,
} as const;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;
    const period = params.get('period') ?? 'month';
    if (!isCallStatsPeriod(period)) return fail('Unknown period');
    const user = params.get('user') || null;
    if (user !== null && !UUID.test(user)) return fail('Unknown person');

    // The zone is presentation: a failed read falls back to the viewer's.
    const zone = await ctx.supabase.rpc('team_activity_limits', {
      p_account: ctx.accountId,
    });
    if (zone.error) console.error('[pbx] call stats zone:', zone.error.message);
    const saved = Array.isArray(zone.data)
      ? (zone.data[0] as { timezone?: unknown } | undefined)?.timezone
      : null;
    const timeZone = reportTimeZone(saved, params.get('tz'));

    const now = new Date();
    const custom = { from: params.get('from'), to: params.get('to') };
    const range = callReportRange(period, now, timeZone, custom);
    if (!range.ok) return fail(PROBLEMS[range.problem]);
    // Like with like: today so far against yesterday up to the same time.
    const previous = callReportPreviousRange(period, now, timeZone, custom);

    const { data, error } = await ctx.supabase.rpc('pbx_call_stats', {
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
      p_tz: timeZone,
      p_user: user,
      p_prev_from: previous?.from.toISOString() ?? null,
      p_prev_to: previous?.to.toISOString() ?? null,
    });
    if (error) {
      if (error.code === '42501')
        return fail('You cannot view that person’s calls', 403);
      // An unknown zone or a refused period: the request, not the server.
      if (error.code === '22023') return fail(error.message);
      if (isMissingFunction(error))
        return fail('The call report needs database migration 119.', 503);
      console.error('[pbx] call stats failed:', error.message);
      return fail('Failed to load the call report', 500);
    }
    const stats = parseCallStats(data);
    if (!stats) {
      console.error('[pbx] call stats: not an object');
      return fail('Failed to load the call report', 500);
    }
    return NextResponse.json({
      stats,
      range: {
        period,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        timeZone,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
