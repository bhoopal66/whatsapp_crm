// ============================================================
// /api/cases/[id]/documents/request — ask the customer, in the case's
// submission group, for every required document not yet received
// (018c, documents.ts). POST, case writers, no body.
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
//       SEND_FAILED     — the gateway failed; the message row is failed.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  requestMissingDocuments,
  type DocRequestResult,
} from '@/lib/cases/documents';
import {
  assertUnderGroupSendLimit,
  caseErrorResponse,
  loadCaseForCaller,
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
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
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
    const result = await requestMissingDocuments(
      {
        tools: caseToolsStore(),
        sender: submissionGroupService(ctx.accountId, supabaseAdmin()),
      },
      { caseId: c.id, actor: ctx.userId }
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
    if (result.reason === 'SEND_FAILED')
      console.error('[cases] documents request: send failed');
    return NextResponse.json(
      { error: NOT_SENT[result.reason], code: result.reason, ...extra },
      { status: 409 }
    );
  } catch (err) {
    return caseErrorResponse(err, 'documents request');
  }
}
