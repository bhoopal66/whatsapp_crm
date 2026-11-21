// PUT /api/desk/duty — `{ userId }` (or null) names who is on duty for
// the desk tray (migration 230): new tray items carry them, and an item
// left past the delay becomes their follow-up task. Team leaders and up.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, readJson, requireUuid } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function PUT(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const body = await readJson(request);
    const userId =
      body.userId === null ? null : requireUuid(body.userId, 'userId');
    await new DeskStore(supabaseAdmin()).setDuty(
      ctx.userId,
      ctx.accountId,
      userId
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return deskErrorResponse(err, 'duty');
  }
}
