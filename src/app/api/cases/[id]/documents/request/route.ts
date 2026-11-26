// ============================================================
// /api/cases/[id]/documents/request — ask the customer, in the case's
// submission group, for every required document not yet received
// (018c, documents.ts). POST, case writers. Body: none, or
// `{ force: true }` to send although it was just requested.
//
//   200 `{ sent: true, docKeys, recorded }` — the customer has the
//       message. `recorded: false`: WhatsApp took it but its row was not
//       settled; it is still sent, so nobody resends it.
//   409 `{ error, code }`, nothing sent and nothing marked:
//       NOTHING_MISSING — every required document is received (or the
//                         case requires none).
//       BLOCKED         — the customer opted out or is do-not-contact
//                         (`blocked`: 'opted_out' | 'do_not_contact').
//       REFUSED         — the group refused the send (`refusal`): the
//                         caller is not on the group's open access list
//                         (SEND_NOT_ALLOWED / UNKNOWN_USER), the group is
//                         not ready, or its number or contact was removed.
//       REQUESTED_RECENTLY — requested less than 10 minutes ago (297):
//                         `by` (user id) and `at`; `force` sends anyway.
//       SEND_FAILED     — nothing went out (the gateway refused it, or it
//                         never got that far).
//   502 `{ error, code: 'UNCONFIRMED' }`: the gateway timed out or answered
//       5xx, so the customer may have it. Nothing is marked.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  requestMissingDocuments,
  type DocRequestResult,
} from '@/lib/cases/documents';
import {
  assertUnderGroupSendLimit,
  caseErrorResponse,
  loadCaseForCaller,
  readJsonObject,
  requireCaseGroup,
} from '@/lib/cases/http';
import { caseStore, caseToolsStore } from '@/lib/cases/server';
import {
  submissionGroupService,
  supabaseAdmin,
} from '@/lib/submission-groups/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const NOT_SENT: Record<
  Exclude<DocRequestResult, { sent: true }>['reason'],
  string
> = {
  NOTHING_MISSING: 'No documents are missing',
  BLOCKED: 'Messaging this customer is blocked',
  REFUSED: 'The request could not be sent in this group',
  SEND_FAILED: 'The request could not be sent',
  UNCONFIRMED: 'The request may have been sent',
};

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: true,
      }
    );
    await assertUnderGroupSendLimit(
      ctx.accountId,
      requireCaseGroup(c),
      ctx.userId
    );
    const force = (await readJsonObject(request))?.force === true;
    const result = await requestMissingDocuments(
      {
        tools: caseToolsStore(),
        sender: submissionGroupService(ctx.accountId, supabaseAdmin()),
      },
      { caseId: c.id, actor: ctx.userId, force }
    );
    if (result.sent)
      return NextResponse.json({
        sent: true,
        docKeys: result.docKeys,
        recorded: result.recorded,
      });

    const extra =
      result.reason === 'BLOCKED'
        ? { blocked: result.blocked }
        : result.reason === 'REFUSED'
          ? { refusal: result.refusal }
          : {};
    if (result.reason === 'SEND_FAILED' || result.reason === 'UNCONFIRMED')
      console.error('[cases] documents request:', result.reason);
    return NextResponse.json(
      { error: NOT_SENT[result.reason], code: result.reason, ...extra },
      { status: result.reason === 'UNCONFIRMED' ? 502 : 409 }
    );
  } catch (err) {
    return caseErrorResponse(err, 'documents request');
  }
}
