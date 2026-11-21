// GET /api/desk/companies/[id]/overview — the company across banks
// (migration 231): `{ overview: { cases, files, consents } }`. Every case
// with its stage only; files of the cases the caller can read; the reuse
// consents. A company the caller cannot read answers 404.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, requireUuid } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const overview = await new DeskStore(supabaseAdmin()).companyOverview(
      ctx.userId,
      ctx.accountId,
      requireUuid((await params).id, 'id')
    );
    return NextResponse.json({ overview });
  } catch (err) {
    return deskErrorResponse(err, 'company overview');
  }
}
