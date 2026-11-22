import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { buildCsv, csvFileName, csvResponse } from '@/lib/csv/build';
import { reportErrorResponse, resolveReportPeriod } from '@/lib/reports/http';
import {
  TAG_CSV_HEADER,
  parseChatTagReport,
  tagCsvRows,
} from '@/lib/reports/tag-report';

/**
 * GET /api/reports/tags/export?range=30d&tz=<IANA zone> → text/csv
 *
 * The chat tag report as a CSV download: the same call, access rule
 * and period as GET /api/reports/tags. Counts only; `buildCsv` quotes
 * every cell and neutralises formula-looking tag names.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer');
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
    if (error) return reportErrorResponse(error, 'export the chat tag report');

    const csv = buildCsv(TAG_CSV_HEADER, tagCsvRows(parseChatTagReport(data)));
    return csvResponse(csv, csvFileName(`chat-tag-report-${period.preset}`));
  } catch (err) {
    return toErrorResponse(err);
  }
}
