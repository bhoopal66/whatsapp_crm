import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isReportKey, parseReportAccessList } from '@/lib/reports/access';
import { reportErrorResponse } from '@/lib/reports/http';

/**
 * Who may open a per-person report (migration 255): owner only.
 *
 *   GET /api/reports/access?report=chat_tags
 *     → { people: [{ userId, name, role, granted, grantedAt }] }
 *   PUT /api/reports/access?report=chat_tags  { userIds: string[] }
 *     → { count }  (the grant list becomes exactly that set)
 *
 * `report_access_list` / `report_access_set` refuse anyone but the
 * owner as well; the SQL is the boundary.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_USERS = 500;

function reportParam(request: Request): string | null {
  const report = new URL(request.url).searchParams.get('report');
  return isReportKey(report) ? report : null;
}

const unknownReport = () =>
  NextResponse.json({ error: 'Unknown report' }, { status: 400 });

export async function GET(request: Request) {
  try {
    const { supabase } = await requireRole('owner');
    const report = reportParam(request);
    if (!report) return unknownReport();

    const { data, error } = await supabase.rpc('report_access_list', {
      p_report: report,
    });
    if (error) return reportErrorResponse(error, 'load report access');

    return NextResponse.json({ people: parseReportAccessList(data) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase } = await requireRole('owner');
    const report = reportParam(request);
    if (!report) return unknownReport();

    const body = (await request.json().catch(() => null)) as {
      userIds?: unknown;
    } | null;
    const ids: unknown = body?.userIds;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_USERS ||
      !ids.every((id) => typeof id === 'string' && UUID_RE.test(id))
    ) {
      return NextResponse.json(
        { error: `userIds must be a list of up to ${MAX_USERS} user ids` },
        { status: 400 }
      );
    }
    const userIds = [
      ...new Set((ids as string[]).map((id) => id.toLowerCase())),
    ];

    const { data, error } = await supabase.rpc('report_access_set', {
      p_report: report,
      p_users: userIds,
    });
    if (error) return reportErrorResponse(error, 'save report access');

    return NextResponse.json({ count: typeof data === 'number' ? data : 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
