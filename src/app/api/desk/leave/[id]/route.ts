// DELETE /api/desk/leave/[id] — removes recorded leave (migration 232):
// one's own, or anyone's by a team leader and up. -> `{ removed }`.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, requireUuid } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const removed = await new DeskStore(supabaseAdmin()).removeLeave(
      ctx.userId,
      ctx.accountId,
      requireUuid((await params).id, 'id')
    );
    return NextResponse.json({ removed });
  } catch (err) {
    return deskErrorResponse(err, 'leave remove');
  }
}
