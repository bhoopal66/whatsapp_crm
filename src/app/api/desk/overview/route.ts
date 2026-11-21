// GET /api/desk/overview — per bank: holders, uploads waiting, the
// oldest's age and an alert (no_coordinator > lead (4 h) > second (2 h)
// > none), plus the no-bank queue. Team leaders and up; else 403
// (migration 220).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const banks = await new DeskStore(supabaseAdmin()).overview(
      ctx.userId,
      ctx.accountId
    );
    return NextResponse.json({ banks });
  } catch (err) {
    return deskErrorResponse(err, 'overview');
  }
}
