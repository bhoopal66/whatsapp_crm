// GET /api/desk/companies/[id]/checklist — the application's merged
// checklist (migration 233): `{ checklist: { cases, items } }`. The
// required documents of the company's open cases the caller can read,
// each once against the strictest validity, with each case's own status.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, requireUuid } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const checklist = await new DeskStore(supabaseAdmin()).applicationChecklist(
      ctx.userId,
      ctx.accountId,
      requireUuid((await params).id, 'id')
    );
    return NextResponse.json({ checklist });
  } catch (err) {
    return deskErrorResponse(err, 'checklist');
  }
}
