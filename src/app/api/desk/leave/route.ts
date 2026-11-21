// POST /api/desk/leave — `{ userId, firstDay, lastDay, note? }`
// (YYYY-MM-DD, Asia/Dubai, inclusive) records leave for desk cover
// (migration 232): one's own, or anyone's by a team leader and up.
// Leave changes no access. -> `{ id }`.
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

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const body = await readJson(request);
    const firstDay = isoDay(body.firstDay);
    const lastDay = isoDay(body.lastDay);
    if (!firstDay || !lastDay)
      throw new DeskBadRequest('days must be YYYY-MM-DD');
    const id = await new DeskStore(supabaseAdmin()).addLeave(
      ctx.userId,
      ctx.accountId,
      {
        userId: requireUuid(body.userId, 'userId'),
        firstDay,
        lastDay,
        note: optionalText(body.note, 200, 'note'),
      }
    );
    return NextResponse.json({ id });
  } catch (err) {
    return deskErrorResponse(err, 'leave');
  }
}
