import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageReportAccess } from '@/lib/auth/roles';
import { reportErrorResponse, resolveReportPeriod } from '@/lib/reports/http';
import { parseChatTagReport } from '@/lib/reports/tag-report';

/**
 * GET /api/reports/tags?range=30d&tz=<IANA zone>
 *   → { report, range: { preset, from, to, tz }, canManageAccess }
 *
 * The chat tag report (migration 255, docs/chat-tag-report.md). Any
 * signed-in staff member reaches the route; `chat_tag_report()` decides
 * who opens it (the owner, or a person the owner granted it), and its
 * NOT_ALLOWED refusal becomes a 403. The period is computed as Team
 * activity computes it, in the account's time zone.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, role } = await requireRole('viewer');
    const period = await resolveReportPeriod(
      supabase,
      accountId,
      new URL(request.url).searchParams
    );
    if (period instanceof NextResponse) return period;

    const { data, error } = await supabase.rpc('chat_tag_report', {
      p_from: period.from.toISOString(),
      p_to: period.to.toISOString(),
      p_tz: period.tz,
    });
    if (error) return reportErrorResponse(error, 'load the chat tag report');

    return NextResponse.json({
      report: parseChatTagReport(data),
      range: {
        preset: period.preset,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        tz: period.tz,
      },
      canManageAccess: canManageReportAccess(role),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
