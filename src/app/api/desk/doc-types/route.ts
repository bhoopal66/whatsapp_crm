// GET /api/desk/doc-types — the document types the workspace's banks ask
// for, as `{ types: [{ key, label }] }`: the labels of its
// `case_doc_requirements` (migration 123) plus any key only a file spec
// (181) names. Feeds the desk forms' pick lists, so nobody types or reads
// a raw id. Account-wide and label-only: no case, bank or customer data.
import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { mergeDocTypes } from '@/lib/desk/doc-types';
import { deskErrorResponse } from '@/lib/desk/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await requireRole('agent'));
    const db = supabaseAdmin();
    const [req, spec] = await Promise.all([
      db
        .from('case_doc_requirements')
        .select('doc_key, label, position')
        .eq('account_id', ctx.accountId)
        .order('position', { ascending: true }),
      db
        .from('case_file_specs')
        .select('doc_key')
        .eq('account_id', ctx.accountId),
    ]);
    if (req.error || spec.error) {
      console.error('[api/desk/doc-types]', req.error?.code, spec.error?.code);
      return NextResponse.json(
        { error: 'Could not load the document types' },
        { status: 500 }
      );
    }
    const types = mergeDocTypes(
      (req.data ?? []).map((r) => ({ key: r.doc_key, label: r.label })),
      (spec.data ?? []).map((r) => r.doc_key)
    );
    return NextResponse.json({ types });
  } catch (err) {
    return deskErrorResponse(err, 'doc types');
  }
}
