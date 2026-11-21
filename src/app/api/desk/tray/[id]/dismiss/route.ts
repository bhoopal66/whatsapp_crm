// POST /api/desk/tray/[id]/dismiss — `{ reason }` (3-500 characters)
// closes a tray document that belongs to no case (migration 230). The
// document stays in the customer's archive (178).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  deskErrorResponse,
  readJson,
  requireText,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const trayId = requireUuid((await params).id, 'id');
    const body = await readJson(request);
    await new DeskStore(supabaseAdmin()).trayDismiss(
      ctx.userId,
      ctx.accountId,
      trayId,
      requireText(body.reason, 500, 'reason')
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return deskErrorResponse(err, 'tray dismiss');
  }
}
