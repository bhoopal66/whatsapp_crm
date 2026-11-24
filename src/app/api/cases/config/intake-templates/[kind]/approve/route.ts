// ============================================================
// POST /api/cases/config/intake-templates/[kind]/approve — owner only.
// Approves the saved wording through case_intake_template_approve on the
// service role: NOT_ALLOWED 403, SELF_APPROVAL 409 (the approver made the
// last edit), TEMPLATE_NOT_FOUND 404. Answers `{ approved: true }`. With
// `{ updatedAt }` (the wording the owner was shown) it approves only that
// wording, 409 TEMPLATE_CHANGED otherwise (309), and answers the row:
// `{ kind, body, approved, updatedAt }`.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { configErrorResponse } from '@/lib/cases/config-http';
import { readJsonObject } from '@/lib/cases/http';
import {
  failIntake,
  intakeKindParam,
  intakeVersion,
} from '@/lib/cases/intake-templates-http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ kind: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('owner'));
    const kind = intakeKindParam((await params).kind);
    const updatedAt = intakeVersion((await readJsonObject(request))?.updatedAt);
    const { data, error } = await supabaseAdmin().rpc(
      'case_intake_template_approve',
      {
        p_actor: ctx.userId,
        p_account: ctx.accountId,
        p_kind: kind,
        ...(updatedAt ? { p_expected_updated_at: updatedAt } : {}),
      }
    );
    if (error) failIntake('case_intake_template_approve', error);
    if (!updatedAt) return NextResponse.json({ approved: true });
    const row = (data ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      kind,
      body: row.body,
      approved: row.approved === true,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    return configErrorResponse(err, 'intake-templates approve');
  }
}
