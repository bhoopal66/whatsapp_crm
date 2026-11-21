// POST /api/desk/intake/[id]/reject — `{ reason }` -> 200 `{ item }`.
// Sorters only, within their banks (migration 220).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  deskErrorResponse,
  optionalText,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const itemId = requireUuid((await params).id, 'id');
    const body = await readJson(request);
    // A blank reason is the SQL's REASON_REQUIRED.
    const reason = optionalText(body.reason, 500, 'reason') ?? '';
    const item = await new DeskStore(supabaseAdmin()).reject(
      ctx.userId,
      ctx.accountId,
      itemId,
      reason
    );
    return NextResponse.json({ item });
  } catch (err) {
    return deskErrorResponse(err, 'intake reject');
  }
}
