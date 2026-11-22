// GET /api/cases/csat?days=90 — CSAT averages overall, per agent and per
// bank (migration 246) over the cases the caller can read (each case
// asked once through case_can_read): `{ enabled, days, overall, byAgent,
// byBank }`. Agent keys are auth user ids; the screen names them.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { aggregateCsat, parseScoreRows } from '@/lib/cases/csat';
import {
  check,
  csatErrorResponse,
  settingsFromRow,
  sinceDays,
} from '@/lib/cases/csat-http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const days = sinceDays(new URL(request.url).searchParams.get('days'));
    const admin = supabaseAdmin();
    const settings = await admin.rpc('case_csat_settings_get', {
      p_actor: ctx.userId,
      p_account: ctx.accountId,
    });
    check('case_csat_settings_get', settings.error);
    if (!settingsFromRow(settings.data).enabled)
      return NextResponse.json({
        enabled: false,
        days,
        overall: null,
        byAgent: [],
        byBank: [],
      });
    const rows = await admin.rpc('case_csat_scores', {
      p_actor: ctx.userId,
      p_account: ctx.accountId,
      p_since: new Date(Date.now() - days * 86_400_000).toISOString(),
    });
    check('case_csat_scores', rows.error);
    return NextResponse.json({
      enabled: true,
      days,
      ...aggregateCsat(parseScoreRows(rows.data)),
    });
  } catch (err) {
    return csatErrorResponse(err, 'csat averages');
  }
}
