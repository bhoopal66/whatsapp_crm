// ============================================================
// POST /api/cases/[id]/takeover — the coordinator or team lead takes the
// customer conversation over (018c). No body.
//
// The hand-over names come from the case: its agent's display name
// (profiles.full_name in the case's account, service role) and its bank's
// name; the lib validates both (NAME_INVALID). Until an approved template
// is wired in lib/cases/server.ts every take-over answers 409
// TEMPLATE_NOT_APPROVED. NOT_ALLOWED (128 decides who) is 403. The log
// row is written before the send and stays, so a send refusal / block
// after it is the conversation route's 409, and a sent-but-not-recorded
// message is 200 `{ sent: true, recorded: false }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { CaseTakeOverRefusedError } from '@/lib/cases/conversations';
import {
  assertUnderGroupSendLimit,
  CASE_NOT_FOUND,
  caseErrorResponse,
  caseSendErrorResponse,
  loadCaseForCaller,
} from '@/lib/cases/http';
import { caseConversations, caseStore } from '@/lib/cases/server';
import { supabaseAdmin } from '@/lib/submission-groups/server';
import { loadNames } from '@/lib/submission-groups/view-refs';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const REFUSED: Record<CaseTakeOverRefusedError['reason'], [number, string]> = {
  TEMPLATE_NOT_APPROVED: [409, 'The hand-over message is not approved yet'],
  NOT_ALLOWED: [403, 'Not allowed'],
  CASE_NOT_FOUND: [404, CASE_NOT_FOUND],
  TEMPLATE_INVALID: [422, 'The hand-over message is not valid'],
  NAME_INVALID: [422, 'The agent or bank name is missing or not valid'],
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    await assertUnderGroupSendLimit(ctx.accountId, c.groupId, ctx.userId);

    const names = await loadNames(supabaseAdmin(), ctx.accountId, [c.agentId]);
    const result = await caseConversations(ctx.accountId).takeOver(
      ctx.userId,
      c.id,
      { agentName: names.get(c.agentId) ?? '', bankName: c.bankName ?? '' }
    );
    return NextResponse.json({ sent: true, recorded: true, ...result });
  } catch (err) {
    if (err instanceof CaseTakeOverRefusedError) {
      const [status, error] = REFUSED[err.reason];
      return NextResponse.json({ error, code: err.reason }, { status });
    }
    return caseSendErrorResponse(err) ?? caseErrorResponse(err);
  }
}
