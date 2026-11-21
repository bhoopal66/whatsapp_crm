// GET /api/cases/[id]/review-drafts — the case file reviewer's drafts
// (migration 225), newest first: `{ enabled, drafts }`. Readers of the
// case. `enabled` false: the reviewer is off for this workspace.
// TENANCY: loadCaseForCaller before any service-role call.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { check, reviewErrorResponse } from '@/lib/case-review/http';
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
    const settings = await admin.rpc('case_review_settings', {
      p_account: c.accountId,
    });
    check('case_review_settings', settings.error);
    const list = await admin.rpc('case_review_drafts_list', {
      p_actor: ctx.userId,
      p_case: c.id,
    });
    check('case_review_drafts_list', list.error);
    const rows = (list.data as Array<Record<string, unknown>> | null) ?? [];
    return NextResponse.json({
      enabled:
        (settings.data as Array<{ review_enabled: boolean }> | null)?.[0]
          ?.review_enabled === true,
      drafts: rows.map((r) => ({
        id: r.id,
        status: r.status,
        narrativeSource: r.narrative_source,
        body: r.body,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
      })),
    });
  } catch (err) {
    return reviewErrorResponse(err, 'review drafts');
  }
}
