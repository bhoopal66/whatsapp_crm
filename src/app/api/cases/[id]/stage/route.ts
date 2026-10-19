// ============================================================
// POST /api/cases/[id]/stage — move a case to a stage (018c).
//
// `{ stage, outcome? }`. A final-stage move ends the submission group
// through the account's 115 service, so the store is built with the
// account id. Answers the store's StageResult as is: `groupEnd.end`
// carries `closeError` / `closeDeferred`, which the UI shows as "the
// WhatsApp group close is pending".
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canWriteCase } from '@/lib/cases/access';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  loadCaseForCaller,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = caseStore(ctx.accountId);
    const { case: c, role } = await loadCaseForCaller(ctx, id, store);
    if (!canWriteCase(role)) throw new CaseHttpError(403, 'Not allowed');

    const body = await readJsonObject(request);
    const stage = parseText(body?.stage);
    if (!body || stage === null) throw badRequest('stage is required');
    let outcome: string | null = null;
    if (body.outcome !== undefined && body.outcome !== null) {
      outcome = parseText(body.outcome);
      if (outcome === null) throw badRequest('outcome is not valid');
    }

    const result = await store.setStage(c.id, ctx.userId, stage, outcome);
    return NextResponse.json(result);
  } catch (err) {
    return caseErrorResponse(err);
  }
}
