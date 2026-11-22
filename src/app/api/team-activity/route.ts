import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  loadTeamActivityReport,
  parseReportQuery,
  reportFailureResponse,
} from '@/lib/team-activity/load-report';

/**
 * Team activity (migration 068): who starts WhatsApp chats, how many get
 * an answer, and the sending patterns that get a Whapi number
 * restricted. Agent and up (migration 205): a leader gets their own
 * team's figures (074), an agent only their own; the SQL decides the
 * scope, not this route, and answers a switched-off view with a hint
 * that becomes a 403 `code`.
 */

/**
 * GET /api/team-activity?range=7d&channel=<number id>&tz=<IANA zone>
 *   → { report: TeamActivityReport, range: { preset, from, to } }
 *
 * The range is computed in the account's zone once an admin has saved
 * one (else the viewer's), so "today" on this page is the same day the
 * limits, the alerts and the block count (`loadTeamActivityReport`).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const parsed = parseReportQuery(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const result = await loadTeamActivityReport(
      supabase,
      accountId,
      parsed.query
    );
    if (result.kind !== 'ok') return reportFailureResponse(result);

    return NextResponse.json({ report: result.report, range: result.range });
  } catch (err) {
    return toErrorResponse(err);
  }
}
