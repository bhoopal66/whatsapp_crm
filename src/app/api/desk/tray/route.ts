// GET /api/desk/tray[?state=open|filed|dismissed] — WhatsApp documents
// the desk router could not place (migration 230): `{ items }`, oldest
// first. Team leaders and up see every item; a bank's holders the items
// with a candidate case at their bank; anyone else none.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { DeskBadRequest, deskErrorResponse } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import type { TrayState } from '@/lib/desk/tray';
import { supabaseAdmin } from '@/lib/submission-groups/server';

const STATES: readonly TrayState[] = ['open', 'filed', 'dismissed'];

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const state = new URL(request.url).searchParams.get('state') ?? 'open';
    if (!STATES.includes(state as TrayState))
      throw new DeskBadRequest('state is not valid');
    const items = await new DeskStore(supabaseAdmin()).tray(
      ctx.userId,
      ctx.accountId,
      state as TrayState
    );
    return NextResponse.json({ items });
  } catch (err) {
    return deskErrorResponse(err, 'tray');
  }
}
