// ============================================================
// POST /api/cases/[id]/memory/forget — erase the case's CRM memory
// (019b, a privacy request). Workspace owner / admin only, with the case
// loaded first (another account's case, or one without a case role, is
// 404). `{ reason }` (non-blank, at most 1000 characters; redacted before
// it reaches the audit). Answers `{ erased }`, the count removed.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  loadCaseForCaller,
  readJsonObject,
} from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { memoryStore } from '@/lib/memory/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    if (!hasMinRole(ctx.role, 'admin'))
      throw new CaseHttpError(403, 'Not allowed');

    const body = await readJsonObject(request);
    if (!body || typeof body.reason !== 'string')
      throw badRequest('reason is required');

    let erased: number;
    try {
      erased = await memoryStore().forget(
        ctx.userId,
        ctx.accountId,
        { type: 'case', id: c.id },
        body.reason
      );
    } catch (err) {
      if (err instanceof RangeError)
        throw badRequest('reason must be 1–1000 characters');
      throw err;
    }
    return NextResponse.json({ erased });
  } catch (err) {
    return caseErrorResponse(err);
  }
}
