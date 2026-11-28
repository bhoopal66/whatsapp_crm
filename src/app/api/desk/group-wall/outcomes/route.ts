// POST /api/desk/group-wall/outcomes — `{ messageIds }` (at most 500):
// what became of each of those group messages that intake recorded, in a
// group the caller can see, with the intake item's current state:
// `{ outcomes }`. Unrecorded messages are left out. Staff (migration 324).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  DeskGroupIntakeStore,
  GROUP_IDS_MAX,
} from '@/lib/desk/group-intake-store';
import {
  DeskBadRequest,
  deskErrorResponse,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const body = await readJson(request);
    if (!Array.isArray(body.messageIds))
      throw new DeskBadRequest('messageIds must be a list');
    if (body.messageIds.length > GROUP_IDS_MAX)
      throw new DeskBadRequest(`At most ${GROUP_IDS_MAX} messages`);
    const ids = [
      ...new Set(body.messageIds.map((v) => requireUuid(v, 'messageIds'))),
    ];
    const outcomes = await new DeskGroupIntakeStore(supabaseAdmin()).outcomes(
      ctx.userId,
      ctx.accountId,
      ids
    );
    return NextResponse.json({ outcomes });
  } catch (err) {
    return deskErrorResponse(err, 'group outcomes');
  }
}
