// GET /api/desk/tray[?state=open|filed|dismissed][&limit=1..1000] — WhatsApp documents
// the desk router could not place (migration 230): `{ items, total,
// hasMore }`, open ones oldest first, resolved ones newest first. Team leaders and up see every item; a bank's holders the items
// with a candidate case at their bank; anyone else none.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { DeskBadRequest, deskErrorResponse } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { TRAY_PAGE, TRAY_PAGE_MAX, type TrayState } from '@/lib/desk/tray';
import { supabaseAdmin } from '@/lib/submission-groups/server';

const STATES: readonly TrayState[] = ['open', 'filed', 'dismissed'];

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const params = new URL(request.url).searchParams;
    const state = params.get('state') ?? 'open';
    const limit = Number(params.get('limit') ?? TRAY_PAGE);
    if (!Number.isInteger(limit) || limit < 1 || limit > TRAY_PAGE_MAX)
      throw new DeskBadRequest('limit is not valid');
    if (!STATES.includes(state as TrayState))
      throw new DeskBadRequest('state is not valid');
    const page = await new DeskStore(supabaseAdmin()).tray(
      ctx.userId,
      ctx.accountId,
      state as TrayState,
      limit
    );
    return NextResponse.json(page);
  } catch (err) {
    return deskErrorResponse(err, 'tray');
  }
}
