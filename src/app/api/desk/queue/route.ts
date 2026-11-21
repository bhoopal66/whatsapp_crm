// GET /api/desk/queue[?bank=CODE] — the sorting queue, oldest first:
// owners / admins / team leaders see every queue, a holder of a bank
// (Settings -> Coordinators) that bank's; anyone else 403 NOT_ALLOWED.
// -> 200 `{ items }` (migration 220).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, optionalText } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const bank = optionalText(
      new URL(request.url).searchParams.get('bank'),
      32,
      'bank'
    );
    const items = await new DeskStore(supabaseAdmin()).queue(
      ctx.userId,
      ctx.accountId,
      bank
    );
    return NextResponse.json({ items });
  } catch (err) {
    return deskErrorResponse(err, 'queue');
  }
}
