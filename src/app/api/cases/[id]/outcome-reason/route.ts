// ============================================================
// /api/cases/[id]/outcome-reason — why a case was declined or withdrawn
// (018c, migration 127). POST (case writers) `{ code, text? }`, code one
// of OUTCOME_REASON_CODES, text ≤ 500 characters -> 200 `{ ok: true }`.
// Once per Declined / Withdrawn case. Refusals answer 422 with `code`:
// REASON_INVALID, REASON_TEXT_TOO_LONG (both also checked here first),
// OUTCOME_NOT_DECLINED (the case is not Declined / Withdrawn),
// REASON_ALREADY_SET.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  OUTCOME_REASON_CODES,
  OUTCOME_REASON_TEXT_CAP,
  type OutcomeReasonCode,
} from '@/lib/cases/dashboard';
import {
  CaseHttpError,
  caseErrorResponse,
  loadCaseForCaller,
  readObject,
} from '@/lib/cases/http';
import { bankDashboard, caseStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

const REFUSED = 'The request was refused';

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: true,
      }
    );
    const b = await readObject(request);
    if (!(OUTCOME_REASON_CODES as readonly unknown[]).includes(b.code))
      throw new CaseHttpError(422, REFUSED, { code: 'REASON_INVALID' });
    if (b.text !== undefined && b.text !== null && typeof b.text !== 'string')
      throw new CaseHttpError(400, 'text must be a string');
    const text =
      typeof b.text === 'string' && b.text.trim() ? b.text.trim() : null;
    if (text !== null && text.length > OUTCOME_REASON_TEXT_CAP)
      throw new CaseHttpError(422, REFUSED, { code: 'REASON_TEXT_TOO_LONG' });

    await bankDashboard().setOutcomeReason(
      ctx.userId,
      c.id,
      b.code as OutcomeReasonCode,
      text
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return caseErrorResponse(err, 'outcome-reason POST');
  }
}
