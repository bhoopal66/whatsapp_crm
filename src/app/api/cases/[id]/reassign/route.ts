// ============================================================
// POST /api/cases/[id]/reassign — change a case's agent or coordinator
// (018c). `{ field: 'agent' | 'coordinator', user_id }`; team lead and up
// on the case. Answers `{ changed, fromUser, toUser }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canReassignCase } from '@/lib/cases/access';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  isUuid,
  loadCaseForCaller,
  readJsonObject,
} from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = caseStore();
    const { case: c, role } = await loadCaseForCaller(ctx, id, store);
    if (!canReassignCase(role)) throw new CaseHttpError(403, 'Not allowed');

    const body = await readJsonObject(request);
    const field = body?.field;
    if (field !== 'agent' && field !== 'coordinator')
      throw badRequest("field must be 'agent' or 'coordinator'");
    if (!isUuid(body?.user_id)) throw badRequest('user_id must be a uuid');

    const result = await store.reassign(c.id, ctx.userId, field, body.user_id);
    return NextResponse.json(result);
  } catch (err) {
    return caseErrorResponse(err);
  }
}
