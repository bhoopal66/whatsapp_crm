// GET /api/desk/lookup?ref=<case number or caption code> — the sorting
// screen's confirmation of a case: `{ case }` (number, bank, company,
// product, stage) or `{ case: null }`. Sorters only; a case outside the
// caller's banks looks the same as an unknown one (migration 220).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, requireText } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const ref = requireText(
      new URL(request.url).searchParams.get('ref'),
      40,
      'ref'
    );
    const found = await new DeskStore(supabaseAdmin()).lookup(
      ctx.userId,
      ctx.accountId,
      ref
    );
    return NextResponse.json({ case: found });
  } catch (err) {
    return deskErrorResponse(err, 'lookup');
  }
}
