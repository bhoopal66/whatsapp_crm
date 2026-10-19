// ============================================================
// GET /api/cases/[id]/timeline — a case's merged timeline (018c).
//
// `?messages=1` adds the live group messages, which goes through
// view_case (an audited read for a coordinator and up). Calls are read
// through the caller's own RLS client, so pbx_can_view_call decides
// which they see. Answers `{ entries }`, oldest first.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { caseErrorResponse, loadCaseForCaller } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { caseTimeline } from '@/lib/cases/timeline';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = caseStore();
    const { case: c } = await loadCaseForCaller(ctx, id, store);

    const flag = new URL(request.url).searchParams.get('messages');
    const entries = await caseTimeline(
      { db: supabaseAdmin(), rlsDb: ctx.supabase, store },
      {
        caseId: c.id,
        actor: ctx.userId,
        includeMessages: flag === '1' || flag === 'true',
      }
    );
    return NextResponse.json({ entries });
  } catch (err) {
    return caseErrorResponse(err);
  }
}
