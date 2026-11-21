// GET /api/desk/worklist — what waits for the caller at the case desk
// (migration 235): `{ desk: { tray, queue, mine, tasks } }`, each a count
// with the oldest age in seconds. Feeds the Case desk card on My worklist.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const desk = await new DeskStore(supabaseAdmin()).worklist(
      ctx.userId,
      ctx.accountId
    );
    return NextResponse.json({ desk });
  } catch (err) {
    return deskErrorResponse(err, 'worklist');
  }
}
