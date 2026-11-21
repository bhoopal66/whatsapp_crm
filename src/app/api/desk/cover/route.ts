// GET /api/desk/cover — per bank with holders: its primary and second
// coordinator, who covers today (primary, else second, else the lead),
// and each holder's leave (migration 232): `{ banks }`. Team leaders and up.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const banks = await new DeskStore(supabaseAdmin()).coverList(
      ctx.userId,
      ctx.accountId
    );
    return NextResponse.json({ banks });
  } catch (err) {
    return deskErrorResponse(err, 'cover');
  }
}
