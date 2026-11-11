// ============================================================
// POST /api/cases/config/intake-templates/[kind]/approve — owner only.
// Approves the saved wording through case_intake_template_approve on the
// service role: NOT_ALLOWED 403, SELF_APPROVAL 409 (the approver made the
// last edit), TEMPLATE_NOT_FOUND 404. Answers `{ approved: true }`.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { configErrorResponse } from '@/lib/cases/config-http';
import { failIntake, intakeKindParam } from '@/lib/cases/intake-templates-http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ kind: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('owner'));
    const kind = intakeKindParam((await params).kind);
    const { error } = await supabaseAdmin().rpc(
      'case_intake_template_approve',
      { p_actor: ctx.userId, p_account: ctx.accountId, p_kind: kind }
    );
    if (error) failIntake('case_intake_template_approve', error);
    return NextResponse.json({ approved: true });
  } catch (err) {
    return configErrorResponse(err, 'intake-templates approve');
  }
}
