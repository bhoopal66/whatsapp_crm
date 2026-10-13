// ============================================================
// GET /api/pbx/calls/report — the supervisor call report, the Calls
// screen's "By person" tab (module 015, migration 098).
//   ?period=today|week|month|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&tz=
//   → { report: CallReport, range: { period, from, to, timeZone } }
//
// Team leader and up. The period is computed here, in the account's
// zone (the one an admin saved for Team activity, else the viewer's
// `tz`, else Asia/Dubai); a custom period is whole days, both
// inclusive, at most 92. pbx_call_report decides whose rows the caller
// gets: owners and admins everyone, a team leader their teams plus
// themselves.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { fail } from '@/lib/pbx/calls';
import {
  CALL_REPORT_MAX_DAYS,
  callReportRange,
  isCallReportPeriod,
  parseCallReport,
  reportTimeZone,
} from '@/lib/pbx/call-report';
import { isMissingFunction } from '@/lib/team-activity/db-errors';

const PROBLEMS = {
  missing: 'A custom period needs from and to dates (YYYY-MM-DD)',
  order: 'The period ends before it starts',
  span: `A custom period spans at most ${CALL_REPORT_MAX_DAYS} days`,
} as const;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('team_leader');
    const params = new URL(request.url).searchParams;
    const period = params.get('period') ?? 'month';
    if (!isCallReportPeriod(period)) return fail('Unknown period');

    // The zone is presentation: a failed read falls back to the viewer's.
    const zone = await ctx.supabase.rpc('team_activity_limits', {
      p_account: ctx.accountId,
    });
    if (zone.error)
      console.error('[pbx] call report zone:', zone.error.message);
    const saved = Array.isArray(zone.data)
      ? (zone.data[0] as { timezone?: unknown } | undefined)?.timezone
      : null;
    const timeZone = reportTimeZone(saved, params.get('tz'));

    const range = callReportRange(period, new Date(), timeZone, {
      from: params.get('from'),
      to: params.get('to'),
    });
    if (!range.ok) return fail(PROBLEMS[range.problem]);

    const { data, error } = await ctx.supabase.rpc('pbx_call_report', {
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
    });
    if (error) {
      if (isMissingFunction(error))
        return fail('The call report needs database migration 098.', 503);
      console.error('[pbx] call report failed:', error.message);
      return fail('Failed to load the call report', 500);
    }
    return NextResponse.json({
      report: parseCallReport(data),
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
