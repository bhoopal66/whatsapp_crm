// PATCH /api/desk/leave/[id] — `{ firstDay, lastDay, note? }` new days
// for recorded leave (migration 328). -> `{ changed }`.
// DELETE /api/desk/leave/[id] — removes recorded leave (migration 232).
// Both: one's own, or anyone's by a team leader and up. -> `{ removed }`.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { isoDay } from '@/lib/desk/cover';
import {
  DeskBadRequest,
  deskErrorResponse,
  optionalText,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const id = requireUuid((await params).id, 'id');
    const body = await readJson(request);
    const firstDay = isoDay(body.firstDay);
    const lastDay = isoDay(body.lastDay);
    if (!firstDay || !lastDay)
      throw new DeskBadRequest('days must be YYYY-MM-DD');
    const changed = await new DeskStore(supabaseAdmin()).changeLeave(
      ctx.userId,
      ctx.accountId,
      id,
      { firstDay, lastDay, note: optionalText(body.note, 200, 'note') }
    );
    return NextResponse.json({ changed });
  } catch (err) {
    return deskErrorResponse(err, 'leave change');
  }
}

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
