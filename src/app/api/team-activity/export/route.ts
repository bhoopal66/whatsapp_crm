import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { csvFileName, csvResponse } from '@/lib/csv/build';
import { isExportTable, teamActivityCsv } from '@/lib/team-activity/export';
import {
  loadTeamActivityReport,
  parseReportQuery,
  reportFailureResponse,
} from '@/lib/team-activity/load-report';

/**
 * GET /api/team-activity/export?range=7d&channel=<id>&tz=<zone>&table=people|numbers
 *   → text/csv attachment
 *
 * Owner only (the owner's decision): the same report, for the same
 * range, as GET /api/team-activity, one row per person or per number.
 * Admins and leaders read the page but cannot download it.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('owner');
    const params = new URL(request.url).searchParams;
    const table = params.get('table') ?? 'people';
    if (!isExportTable(table)) {
      return NextResponse.json({ error: 'Unknown table' }, { status: 400 });
    }
    const parsed = parseReportQuery(params);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const result = await loadTeamActivityReport(
      supabase,
      accountId,
      parsed.query
    );
    if (result.kind !== 'ok') return reportFailureResponse(result);

    const body = teamActivityCsv(result.report, table, {
      from: result.range.from,
      to: result.range.to,
      tz: result.report.tz,
    });
    return csvResponse(
      body,
      csvFileName(`team-activity-${table}-${result.range.preset}`)
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
