import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  COMPOSE_WARNING_CODES,
  type ComposeWarningCode,
} from '@/lib/insights/compose-check';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

/**
 * GET /api/insights/compose-check/stats?days=7 (admin+)
 *   → { days, total, sentAnyway, edited, pending, byCode }
 * Head-count queries on the caller's RLS client (admin+ SELECT):
 * PostgREST returns at most 1,000 rows, so counting rows would
 * under-report a busy week.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const raw = new URL(request.url).searchParams.get('days');
    let days = DEFAULT_DAYS;
    if (raw !== null) {
      days = Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)
        return NextResponse.json(
          { error: `days must be a whole number from 1 to ${MAX_DAYS}` },
          { status: 400 }
        );
    }
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const base = () =>
      supabase
        .from('compose_check_events')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gte('created_at', since);

    const [total, sentAnyway, edited, pending, ...perCode] = await Promise.all([
      base(),
      base().eq('outcome', 'sent_anyway'),
      base().eq('outcome', 'edited'),
      base().eq('outcome', 'pending'),
      ...COMPOSE_WARNING_CODES.map((code) =>
        base().contains('warnings', [code])
      ),
    ]);
    const failed = [total, sentAnyway, edited, pending, ...perCode].find(
      (r) => r.error
    );
    if (failed) {
      console.error(
        '[compose-check stats] count error:',
        failed.error?.message
      );
      return NextResponse.json(
        { error: 'Failed to load the statistics' },
        { status: 500 }
      );
    }

    const byCode = {} as Record<ComposeWarningCode, number>;
    COMPOSE_WARNING_CODES.forEach((code, i) => {
      byCode[code] = perCode[i].count ?? 0;
    });
    return NextResponse.json({
      days,
      total: total.count ?? 0,
      sentAnyway: sentAnyway.count ?? 0,
      edited: edited.count ?? 0,
      pending: pending.count ?? 0,
      byCode,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
