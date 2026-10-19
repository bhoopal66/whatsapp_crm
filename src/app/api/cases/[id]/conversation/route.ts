// ============================================================
// /api/cases/[id]/conversation — the case's customer conversation (018c).
//
// GET: an audited read (view_case writes its row before any message is
// fetched). An ENDED group is read only through 115's archive. Answers
// `{ groupId, archived, messages }` (messages in the submission-group
// message view shape), or 404 NOT_READABLE.
//
// POST `{ text }` (trimmed, 1–4096): a case writer replies through 115's
// guarded send. Send refusals and consent blocks are 409 with a code; a
// message WhatsApp accepted but whose row was not recorded is 200
// `{ sent: true, recorded: false }`. Success is 201.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canWriteCase } from '@/lib/cases/access';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  caseSendErrorResponse,
  loadCaseForCaller,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { caseConversations, caseStore } from '@/lib/cases/server';
import { SG_TEXT_MAX } from '@/lib/submission-groups/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';
import { loadNames } from '@/lib/submission-groups/view-refs';
import { toMessageView } from '@/lib/submission-groups/views';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());

    const read = await caseConversations(ctx.accountId).read(ctx.userId, c.id);
    if (!read.allowed)
      throw new CaseHttpError(404, 'Conversation not readable', {
        code: 'NOT_READABLE',
      });
    const names = await loadNames(
      supabaseAdmin(),
      ctx.accountId,
      read.messages.map((m) => m.senderUserId)
    );
    return NextResponse.json({
      groupId: read.groupId,
      archived: read.archived,
      messages: read.messages.map((m) => toMessageView(m, names)),
    });
  } catch (err) {
    return caseErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c, role } = await loadCaseForCaller(ctx, id, caseStore());
    if (!canWriteCase(role)) throw new CaseHttpError(403, 'Not allowed');

    const body = await readJsonObject(request);
    const text = parseText(body?.text, SG_TEXT_MAX);
    if (text === null)
      throw badRequest(`text must be 1–${SG_TEXT_MAX} characters`);

    const sent = await caseConversations(ctx.accountId).reply(
      ctx.userId,
      c.id,
      text
    );
    return NextResponse.json(
      { sent: true, recorded: true, ...sent },
      { status: 201 }
    );
  } catch (err) {
    return caseSendErrorResponse(err) ?? caseErrorResponse(err);
  }
}
