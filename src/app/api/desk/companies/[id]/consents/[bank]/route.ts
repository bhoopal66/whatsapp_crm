// PUT /api/desk/companies/[id]/consents/[bank] — `{ evidence }` records
// the company's consent to reuse its documents at that bank. DELETE —
// `{ reason }` revokes it. Writers of one of the company's cases, team
// leaders and up (migration 231). Never deleted: the history stays.
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

type Params = { params: Promise<{ id: string; bank: string }> };

async function target(params: Params['params']) {
  const p = await params;
  return {
    customerId: requireUuid(p.id, 'id'),
    bankCode: requireText(decodeURIComponent(p.bank), 32, 'bank'),
  };
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { customerId, bankCode } = await target(params);
    const body = await readJson(request);
    await new DeskStore(supabaseAdmin()).grantConsent(
      ctx.userId,
      ctx.accountId,
      customerId,
      bankCode,
      requireText(body.evidence, 500, 'evidence')
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return deskErrorResponse(err, 'consent grant');
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { customerId, bankCode } = await target(params);
    const body = await readJson(request);
    await new DeskStore(supabaseAdmin()).revokeConsent(
      ctx.userId,
      ctx.accountId,
      customerId,
      bankCode,
      requireText(body.reason, 500, 'reason')
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return deskErrorResponse(err, 'consent revoke');
  }
}
