// GET /api/cases/[id]/csat — the case's CSAT rating requests and any
// score (migration 246): `{ enabled, items }`. Readers of the case.
// `enabled` false: CSAT is off for this workspace (the page shows nothing).
// TENANCY: loadCaseForCaller before any service-role call.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  caseCsatItems,
  check,
  csatErrorResponse,
  settingsFromRow,
} from '@/lib/cases/csat-http';
import { loadCaseForCaller } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { case: c } = await loadCaseForCaller(
      ctx,
      (await params).id,
      caseStore()
    );
    const admin = supabaseAdmin();
    const settings = await admin.rpc('case_csat_settings_get', {
      p_actor: ctx.userId,
      p_account: c.accountId,
    });
    check('case_csat_settings_get', settings.error);
    if (!settingsFromRow(settings.data).enabled)
      return NextResponse.json({ enabled: false, items: [] });
    const list = await admin.rpc('case_csat_for_case', {
      p_actor: ctx.userId,
      p_case: c.id,
    });
    check('case_csat_for_case', list.error);
    return NextResponse.json({
      enabled: true,
      items: caseCsatItems(list.data),
    });
  } catch (err) {
    return csatErrorResponse(err, 'case csat');
  }
}
