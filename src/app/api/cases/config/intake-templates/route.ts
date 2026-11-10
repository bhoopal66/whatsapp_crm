// ============================================================
// GET /api/cases/config/intake-templates — Settings -> Cases: the wording
// of the WhatsApp document intake messages (migration 183). Agent and up,
// the caller's RLS client. Answers `{ templates: [{ kind, body, approved,
// approvedBy, approvedAt, updatedBy, updatedAt }] }`, always the three
// kinds in order; a kind never written is `body: null, approved: false`
// with the rest null.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { configErrorResponse, readRows } from '@/lib/cases/config-http';
import { INTAKE_TEMPLATE_KINDS } from '@/lib/cases/intake-templates-http';

const text = (v: unknown) => (typeof v === 'string' ? v : null);

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const rows = await readRows(
      ctx.supabase
        .from('case_intake_templates')
        .select(
          'kind, body, approved, approved_by, approved_at, updated_by, updated_at'
        )
        .eq('account_id', ctx.accountId),
      'case_intake_templates'
    );
    const templates = INTAKE_TEMPLATE_KINDS.map((kind) => {
      const r = rows.find((x) => x.kind === kind);
      return {
        kind,
        body: text(r?.body),
        approved: r?.approved === true,
        approvedBy: text(r?.approved_by),
        approvedAt: text(r?.approved_at),
        updatedBy: text(r?.updated_by),
        updatedAt: text(r?.updated_at),
      };
    });
    return NextResponse.json({ templates });
  } catch (err) {
    return configErrorResponse(err, 'intake-templates GET');
  }
}
