// ============================================================
// /api/cases/[id]/bank-contacts — the case's bank contact log (018c,
// migration 124). INTERNAL and append-only. GET (any case role):
// `{ contacts }`, each `{ id, caseId, contactName, contactedAt, summary,
// nextAction, nextActionAt, authorId, createdAt }`. POST (case writers)
// `{ contact_name, contacted_at, summary, next_action?, next_action_at? }`
// (name ≤ 200, summary and next action ≤ 4000 characters; dates ISO)
// -> 201 `{ id }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { BANK_CONTACT_CAPS } from '@/lib/cases/bank-contacts';
import {
  caseErrorResponse,
  loadCaseForCaller,
  optionalDate,
  optionalText,
  readObject,
  requiredDate,
  requiredText,
} from '@/lib/cases/route-helpers';
import { caseBankContactsStore, caseStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      caseStore(ctx.accountId),
      ctx,
      id,
      {
        write: false,
      }
    );
    return NextResponse.json({
      contacts: await caseBankContactsStore().list(c.id),
    });
  } catch (err) {
    return caseErrorResponse(err, 'bank-contacts GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      caseStore(ctx.accountId),
      ctx,
      id,
      {
        write: true,
      }
    );
    const b = await readObject(request);
    const input = {
      caseId: c.id,
      actor: ctx.userId,
      contactName: requiredText(
        b.contact_name,
        'contact_name',
        BANK_CONTACT_CAPS.contactName
      ),
      contactedAt: requiredDate(b.contacted_at, 'contacted_at'),
      summary: requiredText(b.summary, 'summary', BANK_CONTACT_CAPS.summary),
      nextAction: optionalText(
        b.next_action,
        'next_action',
        BANK_CONTACT_CAPS.nextAction
      ),
      nextActionAt: optionalDate(b.next_action_at, 'next_action_at'),
    };
    const newId = await caseBankContactsStore().add(input);
    return NextResponse.json({ id: newId }, { status: 201 });
  } catch (err) {
    return caseErrorResponse(err, 'bank-contacts POST');
  }
}
