import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadFunnelReport } from '@/lib/reports/funnel-server';

/**
 * GET /api/reports/funnel?range=30d&lead_source=&agent=&bank=&channel=&tz=
 *   → { report: FunnelReport, range: { preset, from, to, tz } }
 *
 * The Funnel report (migration 254). Owners and admins only; the SQL
 * refuses anyone else as well. The range is computed in the account's
 * zone exactly as /api/team-activity does. docs/funnel-report.md.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const loaded = await loadFunnelReport(
      supabase,
      accountId,
      new URL(request.url).searchParams
    );
    if (!loaded.ok) return loaded.response;
    return NextResponse.json(
      { report: loaded.report, range: loaded.range },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
