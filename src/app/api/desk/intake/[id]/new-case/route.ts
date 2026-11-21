// POST /api/desk/intake/[id]/new-case — a sorter opens (or joins) the
// company's case at a bank for an upload: `{ tradeLicence, legalName,
// bankCode, product, contactId }` -> 200 `{ item }` with the case number.
// Opened in the uploader's name; a sorter holding the bank is named its
// coordinator (migration 220).
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
    const itemId = requireUuid((await params).id, 'id');
    const body = await readJson(request);
    const item = await new DeskStore(supabaseAdmin()).fileNewCase(
      ctx.userId,
      ctx.accountId,
      itemId,
      {
        tradeLicence: requireText(body.tradeLicence, 64, 'tradeLicence'),
        legalName: requireText(body.legalName, 200, 'legalName'),
        bankCode: requireText(body.bankCode, 32, 'bankCode'),
        product: requireText(body.product, 200, 'product'),
        contactId: requireUuid(body.contactId, 'contactId'),
      }
    );
    return NextResponse.json({ item });
  } catch (err) {
    return deskErrorResponse(err, 'intake new case');
  }
}
