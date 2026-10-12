// ============================================================
// GET /api/pbx/calls/summary — "calls this month" (module 015,
// migration 089).
//   ?contactId=&tz= → { total, answered, missed, talkSeconds }
//
// The current month in `tz` (an IANA zone; the workspace's Asia/Dubai
// when absent), from midnight on the 1st. Read on the caller's client,
// so it counts the calls they can see, of one contact when contactId is
// given. Paged until the count is reached, so PostgREST's max-rows
// cannot cut it short. Viewer+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  DEFAULT_TIME_ZONE,
  UUID,
  fail,
  isTimeZone,
  monthStart,
  summarizeMonth,
} from '@/lib/pbx/calls';

const PAGE = 1000;
type Row = Parameters<typeof summarizeMonth>[0][number];

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;
    const contactId = params.get('contactId') || null;
    if (contactId && !UUID.test(contactId))
      return fail('contactId must be an id');
    const tz = params.get('tz') || DEFAULT_TIME_ZONE;
    if (!isTimeZone(tz)) return fail('tz must be an IANA time zone');
    const from = monthStart(new Date(), tz).toISOString();

    const rows: Row[] = [];
    let total = Infinity;
    while (rows.length < total) {
      let query = ctx.supabase
        .from('calls')
        .select('direction, status, answered_at, talk_seconds', {
          count: 'exact',
        })
        .eq('account_id', ctx.accountId)
        .gte('started_at', from);
      if (contactId) query = query.eq('contact_id', contactId);
      const { data, error, count } = await query
        .order('started_at', { ascending: true })
        .range(rows.length, rows.length + PAGE - 1);
      if (error) throw new Error(`calls read failed: ${error.message}`);
      const page = (data ?? []) as Row[];
      rows.push(...page);
      if (!page.length) break;
      total = count ?? rows.length;
    }
    return NextResponse.json(summarizeMonth(rows));
  } catch (err) {
    return toErrorResponse(err);
  }
}
