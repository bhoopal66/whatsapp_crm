// ============================================================
// /api/cases/leads — listing a contact's cases (130).
//
// GET ?contactId=<uuid>: the contact's cases the caller may read.
// TENANCY: the caller's ACTIVE account.
//
// No POST: cases come only from the submission tracker (Compass), so
// nobody opens a lead in the CRM. The route has no POST handler, so Next
// answers 405. 130's case_open_lead stays in SQL with no caller.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { canReadCase } from '@/lib/cases/access';
import { badRequest, caseErrorResponse, isUuid } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const contactId = new URL(request.url).searchParams.get('contactId');
    if (!isUuid(contactId)) throw badRequest('contactId must be a uuid');

    const store = caseStore(ctx.accountId);
    const all = await store.listForContact(ctx.accountId, contactId);
    const roles = await Promise.all(
      all.map((c) => store.role(c.id, ctx.userId))
    );
    const cases = all
      .filter((_, i) => canReadCase(roles[i]))
      .map((c) => ({
        id: c.id,
        stage: c.stage,
        bankCode: c.bankCode,
        product: c.product,
        amount: c.amount,
        isLead: c.isLead,
        openedAt: c.openedAt,
        closedAt: c.closedAt,
      }));
    return NextResponse.json({ cases }, { headers: NO_STORE });
  } catch (err) {
    return caseErrorResponse(err);
  }
}
