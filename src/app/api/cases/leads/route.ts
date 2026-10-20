// ============================================================
// /api/cases/leads — opening a lead and listing a contact's cases (130).
//
// A lead is a case with no submission group: the agent (or an owner /
// admin, or the agent's team leader) opens it from a contact; a later
// submission of the same contact and bank attaches to it.
//
// POST: agent and up. The actor is the signed-in user, never the body;
// `agentId` defaults to the actor. The database decides who may open for
// whom (case_open_lead) and answers its own refusals (LEAD_EXISTS /
// CASE_EXISTS 409, the rest 422). 201 `{ id }`.
//
// GET ?contactId=<uuid>: the contact's cases the caller may read.
// TENANCY: both use the caller's ACTIVE account.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { canReadCase } from '@/lib/cases/access';
import {
  badRequest,
  caseErrorResponse,
  isUuid,
  optionalText,
  parseAmount,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = await readJsonObject(request);
    if (!body || !isUuid(body.contactId))
      throw badRequest('contactId must be a uuid');
    const bankCode = parseText(body.bankCode, 32);
    if (!bankCode) throw badRequest('bankCode is required');
    const product = parseText(body.product);
    if (!product) throw badRequest('product is required');

    let amount: string | null = null;
    if (body.amount !== undefined && body.amount !== null) {
      amount = parseAmount(body.amount);
      if (amount === null) throw badRequest('amount is not valid');
    }
    for (const k of ['agentId', 'coordinatorId'] as const) {
      const v = body[k];
      if (v !== undefined && v !== null && !isUuid(v))
        throw badRequest(`${k} must be a uuid`);
    }
    const leadSource = optionalText(body.leadSource, 'leadSource', 200);

    const id = await caseStore(ctx.accountId).openLead({
      actor: ctx.userId,
      accountId: ctx.accountId,
      contactId: body.contactId,
      bankCode,
      product,
      agentId: typeof body.agentId === 'string' ? body.agentId : ctx.userId,
      amount,
      coordinatorId:
        typeof body.coordinatorId === 'string' ? body.coordinatorId : null,
      leadSource,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return caseErrorResponse(err);
  }
}

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
