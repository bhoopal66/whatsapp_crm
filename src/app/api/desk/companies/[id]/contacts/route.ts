// GET /api/desk/companies/[id]/contacts — the people who act for a
// company (role, authorised, linked automatically or by a person):
// `{ contacts }`. A company the caller may not read answers 404
// CUSTOMER_NOT_FOUND, like an unknown one (migration 229).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, requireUuid } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const customerId = requireUuid((await params).id, 'id');
    const contacts = await new DeskStore(supabaseAdmin()).companyContacts(
      ctx.userId,
      ctx.accountId,
      customerId
    );
    return NextResponse.json({ contacts });
  } catch (err) {
    return deskErrorResponse(err, 'company contacts');
  }
}
