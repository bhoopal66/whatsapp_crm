// PUT /api/desk/cover/[bank] — `{ role: 'primary' | 'second', userId }`
// (userId null clears it) names a bank's coordinator from its holders
// (migration 232). Owners and admins.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  DeskBadRequest,
  deskErrorResponse,
  readJson,
  requireText,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ bank: string }> };

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const bank = requireText(
      decodeURIComponent((await params).bank),
      32,
      'bank'
    );
    const body = await readJson(request);
    if (body.role !== 'primary' && body.role !== 'second')
      throw new DeskBadRequest('role is not valid');
    const userId =
      body.userId === null ? null : requireUuid(body.userId, 'userId');
    await new DeskStore(supabaseAdmin()).setBankRole(
      ctx.userId,
      ctx.accountId,
      bank,
      body.role,
      userId
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return deskErrorResponse(err, 'bank role');
  }
}
