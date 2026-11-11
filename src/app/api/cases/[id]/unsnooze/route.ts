// ============================================================
// POST /api/cases/[id]/unsnooze — end a running snooze (migration 185)
// -> `{ snoozedUntil: null }`.
//
// TENANCY FIRST, as the snooze route (404). Same roles as a snooze (403
// NOT_ALLOWED), 409 CASE_CLOSED, 422 SNOOZE_INVALID when no snooze runs.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { caseErrorResponse, loadCaseForCaller } from '@/lib/cases/http';
import { caseStore, caseViews } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    await caseViews().unsnooze(ctx.userId, c.id);
    return NextResponse.json({ snoozedUntil: null });
  } catch (err) {
    return caseErrorResponse(err, 'unsnooze');
  }
}
