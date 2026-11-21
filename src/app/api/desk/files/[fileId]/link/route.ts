// POST /api/desk/files/[fileId]/link — `{ caseId }` links the file's
// stored document into another open case of the same company (migration
// 231): `{ fileId, created }`. Nothing is copied; the new case's row has
// its own status. Another bank needs the company's consent
// (CONSENT_MISSING); another company is refused (CROSS_CUSTOMER).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, readJson, requireUuid } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ fileId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const fileId = requireUuid((await params).fileId, 'fileId');
    const body = await readJson(request);
    const linked = await new DeskStore(supabaseAdmin()).linkDocument(
      ctx.userId,
      ctx.accountId,
      fileId,
      requireUuid(body.caseId, 'caseId')
    );
    return NextResponse.json(linked);
  } catch (err) {
    return deskErrorResponse(err, 'document link');
  }
}
