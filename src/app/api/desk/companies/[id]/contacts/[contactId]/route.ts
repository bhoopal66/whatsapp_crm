// PUT /api/desk/companies/[id]/contacts/[contactId] — `{ role,
// authorised }` links a contact the caller can see to the company, or
// updates the link -> `{ created }`. DELETE unlinks -> `{ removed }`.
// A writer of one of the company's cases, or team leader and up
// (migration 229). A link opens nothing to anyone.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { isDeskContactRole } from '@/lib/desk/companies';
import {
  DeskBadRequest,
  deskErrorResponse,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string; contactId: string }> };

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const p = await params;
    const customerId = requireUuid(p.id, 'id');
    const contactId = requireUuid(p.contactId, 'contactId');
    const body = await readJson(request);
    if (!isDeskContactRole(body.role))
      throw new DeskBadRequest('role is not valid');
    if (typeof body.authorised !== 'boolean')
      throw new DeskBadRequest('authorised must be true or false');
    const created = await new DeskStore(supabaseAdmin()).setCompanyContact(
      ctx.userId,
      ctx.accountId,
      customerId,
      contactId,
      body.role,
      body.authorised
    );
    return NextResponse.json({ created });
  } catch (err) {
    return deskErrorResponse(err, 'company contact set');
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const p = await params;
    const removed = await new DeskStore(supabaseAdmin()).removeCompanyContact(
      ctx.userId,
      ctx.accountId,
      requireUuid(p.id, 'id'),
      requireUuid(p.contactId, 'contactId')
    );
    return NextResponse.json({ removed });
  } catch (err) {
    return deskErrorResponse(err, 'company contact remove');
  }
}
