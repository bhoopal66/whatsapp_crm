// ============================================================
// DELETE /api/cases/rules/[id] — remove a case rule (migration 187).
// Owner / admin. Answers `{ ok: true }`.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { isUuid } from '@/lib/cases/http';
import { CaseRulesRefusedError, CaseRulesStore } from '@/lib/cases/rules';
import { caseRulesErrorResponse } from '@/lib/cases/rules-http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const { id } = await params;
    if (!isUuid(id)) throw new CaseRulesRefusedError('RULE_NOT_FOUND');
    await new CaseRulesStore(supabaseAdmin()).delete(ctx.userId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return caseRulesErrorResponse(err);
  }
}
