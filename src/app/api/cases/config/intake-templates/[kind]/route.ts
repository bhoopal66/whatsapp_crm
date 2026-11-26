// ============================================================
// PUT /api/cases/config/intake-templates/[kind] — owner / admin. Body
// `{ body: string, updatedAt?: string | null }` (1..1000 characters, not
// blank). Saves the wording through case_intake_template_set on the
// service role (it re-checks the writer: NOT_ALLOWED 403). With
// `updatedAt` (the version the screen showed, null for none) it is 409
// TEMPLATE_CHANGED when another is stored. Any change resets approval;
// answers `{ approved }` as stored. Unknown kind: 404. The account is the
// caller's active one.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { configErrorResponse } from '@/lib/cases/config-http';
import { readObject } from '@/lib/cases/http';
import { isStaleSave } from '@/lib/settings/stale';
import {
  failIntake,
  intakeBody,
  intakeKindParam,
  intakeVersion,
} from '@/lib/cases/intake-templates-http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ kind: string }> };

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const kind = intakeKindParam((await params).kind);
    const sent = await readObject(request);
    const body = intakeBody(sent.body);
    if (sent.updatedAt !== undefined) {
      const shown = intakeVersion(sent.updatedAt);
      const { data: row, error } = await supabaseAdmin()
        .from('case_intake_templates')
        .select('updated_at')
        .eq('account_id', ctx.accountId)
        .eq('kind', kind)
        .maybeSingle();
      if (error) failIntake('case_intake_templates', error);
      if (isStaleSave(shown, (row?.updated_at as string) ?? null))
        failIntake('case_intake_template_set', { hint: 'TEMPLATE_CHANGED' });
    }
    const { data, error } = await supabaseAdmin().rpc(
      'case_intake_template_set',
      {
        p_actor: ctx.userId,
        p_account: ctx.accountId,
        p_kind: kind,
        p_body: body,
      }
    );
    if (error) failIntake('case_intake_template_set', error);
    return NextResponse.json({ approved: data === true });
  } catch (err) {
    return configErrorResponse(err, 'intake-templates PUT');
  }
}
