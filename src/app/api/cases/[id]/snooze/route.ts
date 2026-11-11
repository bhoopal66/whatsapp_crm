// ============================================================
// POST /api/cases/[id]/snooze — snooze a case out of the default inbox
// (migration 185). `{ until, reason? }` -> `{ snoozedUntil }`.
//
// TENANCY FIRST: case_role ignores the active workspace, so the case's
// account and the caller's read right are checked before the snooze call
// (404). 185 then decides: 403 NOT_ALLOWED (an agent, or anyone not the
// coordinator / team lead / admin / owner), 409 CASE_CLOSED, 422
// SNOOZE_INVALID (until not in (now, now + 30 days], reason over 200).
// SLA-neutral: no timer moves.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  badRequest,
  caseErrorResponse,
  loadCaseForCaller,
  readObject,
  requiredDate,
} from '@/lib/cases/http';
import { caseStore, caseViews } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const body = await readObject(request);
    const until = requiredDate(body.until, 'until');
    let reason: string | null = null;
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string')
        throw badRequest('reason must be text');
      reason = body.reason;
    }
    const snoozedUntil = await caseViews().snooze(
      ctx.userId,
      c.id,
      until,
      reason
    );
    return NextResponse.json({ snoozedUntil });
  } catch (err) {
    return caseErrorResponse(err, 'snooze');
  }
}
