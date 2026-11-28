// GET /api/desk/group-wall?ids=a,b,c — per linked group among the ids
// that the caller can see, the bank, its coordinators, today's filings
// and its sorting queue with the queue alert: `{ banks }`, in the order
// asked. Unlinked or hidden groups are left out. Staff (migration 334).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { DeskGroupIntakeStore } from '@/lib/desk/group-intake-store';
import {
  DeskBadRequest,
  deskErrorResponse,
  requireUuid,
} from '@/lib/desk/http';
import { WALL_MAX_COLUMNS } from '@/lib/groups/wall';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const raw = new URL(request.url).searchParams.get('ids') ?? '';
    const ids = [
      ...new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => requireUuid(s, 'ids'))
      ),
    ];
    if (ids.length > WALL_MAX_COLUMNS)
      throw new DeskBadRequest(`At most ${WALL_MAX_COLUMNS} groups`);
    const banks = await new DeskGroupIntakeStore(supabaseAdmin()).wall(
      ctx.userId,
      ctx.accountId,
      ids
    );
    return NextResponse.json({ banks });
  } catch (err) {
    return deskErrorResponse(err, 'group wall');
  }
}
