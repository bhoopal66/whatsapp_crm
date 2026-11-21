// GET /api/desk/banks — every bank of the workspace with its three-letter
// desk code (null when none): `{ banks }`. Any staff member (the upload
// form's bank list) (migration 220).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const banks = await new DeskStore(supabaseAdmin()).banks(
      ctx.userId,
      ctx.accountId
    );
    return NextResponse.json({ banks });
  } catch (err) {
    return deskErrorResponse(err, 'banks');
  }
}
