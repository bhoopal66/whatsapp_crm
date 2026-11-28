// GET /api/desk/group-links — the bank links of the WhatsApp groups the
// caller can see: `{ links }`. Staff (migration 334).
// PUT — `{ groupId, bankCode, intakeEnabled, repliesEnabled }`; a null
// bankCode removes the link. Owners, admins and team leaders who can see
// the group (the SQL decides); replies only with intake on. `{ ok: true }`.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { DeskGroupIntakeStore } from '@/lib/desk/group-intake-store';
import {
  DeskBadRequest,
  deskErrorResponse,
  readJson,
  requireText,
  requireUuid,
} from '@/lib/desk/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const links = await new DeskGroupIntakeStore(supabaseAdmin()).listLinks(
      ctx.userId,
      ctx.accountId
    );
    return NextResponse.json({ links });
  } catch (err) {
    return deskErrorResponse(err, 'group links');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const body = await readJson(request);
    const groupId = requireUuid(body.groupId, 'groupId');
    if (body.bankCode !== null && typeof body.bankCode !== 'string')
      throw new DeskBadRequest('bankCode must be a bank code or null');
    if (typeof body.intakeEnabled !== 'boolean')
      throw new DeskBadRequest('intakeEnabled must be true or false');
    if (typeof body.repliesEnabled !== 'boolean')
      throw new DeskBadRequest('repliesEnabled must be true or false');
    const link =
      body.bankCode === null
        ? null
        : {
            bankCode: requireText(body.bankCode, 64, 'bankCode'),
            intakeEnabled: body.intakeEnabled,
            repliesEnabled: body.repliesEnabled,
          };
    await new DeskGroupIntakeStore(supabaseAdmin()).setLink(
      ctx.userId,
      ctx.accountId,
      groupId,
      link
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return deskErrorResponse(err, 'group link save');
  }
}
