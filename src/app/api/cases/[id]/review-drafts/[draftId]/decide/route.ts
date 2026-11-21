// POST /api/cases/[id]/review-drafts/[draftId]/decide — `{ approve }`
// -> 200 `{ status }` (approved | rejected). Writers of the case; a
// second decision is 409 ALREADY_DECIDED (migration 225). Deciding
// changes nothing else: the draft is advice.
// TENANCY: loadCaseForCaller before any service-role call.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  check,
  reviewErrorResponse,
  ReviewRefused,
} from '@/lib/case-review/http';
import { isUuid, loadCaseForCaller } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string; draftId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id, draftId } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    if (!isUuid(draftId)) throw new ReviewRefused('DRAFT_NOT_FOUND');
    const body = (await request.json().catch(() => null)) as {
      approve?: unknown;
    } | null;
    if (typeof body?.approve !== 'boolean') throw new ReviewRefused('INVALID');
    const { data, error } = await supabaseAdmin().rpc(
      'case_review_draft_decide',
      {
        p_actor: ctx.userId,
        p_case: c.id,
        p_draft: draftId,
        p_approve: body.approve,
      }
    );
    check('case_review_draft_decide', error);
    return NextResponse.json({ status: data });
  } catch (err) {
    return reviewErrorResponse(err, 'review decide');
  }
}
