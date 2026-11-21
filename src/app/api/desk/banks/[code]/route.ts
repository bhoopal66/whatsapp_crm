// PUT /api/desk/banks/[code] — `{ shortCode }` sets the bank's
// three-letter desk code (owner / admin; a bank with numbered cases keeps
// its code) -> 200 `{ ok: true }` (migration 220).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, readJson, requireText } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ code: string }> };

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const bankCode = requireText(
      decodeURIComponent((await params).code),
      32,
      'code'
    );
    const body = await readJson(request);
    await new DeskStore(supabaseAdmin()).setBankCode(
      ctx.userId,
      ctx.accountId,
      bankCode,
      requireText(body.shortCode, 3, 'shortCode')
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return deskErrorResponse(err, 'bank code');
  }
}
