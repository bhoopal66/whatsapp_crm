// ============================================================
// GET /api/cases/[id]/audit — who viewed this case's conversations
// (018c, case_view_audit). Admin / super_admin on the case only; `?limit`
// (default 100; the database refuses an out-of-range one, 422).
// Answers `{ rows }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  badRequest,
  canSeeCaseAudit,
  caseErrorResponse,
  CaseHttpError,
  loadCaseForCaller,
} from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';

const AUDIT_DEFAULT_LIMIT = 100;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = caseStore();
    const { case: c, role } = await loadCaseForCaller(ctx, id, store);
    if (!canSeeCaseAudit(role)) throw new CaseHttpError(403, 'Not allowed');

    const raw = new URL(request.url).searchParams.get('limit');
    let limit = AUDIT_DEFAULT_LIMIT;
    if (raw !== null && raw !== '') {
      if (!/^\d{1,9}$/.test(raw))
        throw badRequest('limit must be a whole number');
      limit = Number(raw);
    }

    const rows = await store.auditList(ctx.userId, c.id, limit);
    return NextResponse.json({ rows });
  } catch (err) {
    return caseErrorResponse(err);
  }
}
