// ============================================================
// /api/cases/[id]/conversation — the case's customer conversation (018c).
//
// GET: an audited read (view_case writes its row before any message is
// fetched). An ENDED group is read only through 115's archive. Answers
// `{ groupId, archived, waMode, truncated, messages }` (a live group's
// newest messages, `truncated` when older ones are left out, in the
// submission-group message view shape; waMode 'group' | 'none' (136: no
// WhatsApp group, nothing can be sent) | null without a group row), or
// 404 NOT_READABLE.
//
// POST `{ text }` (trimmed, 1–4096), or (210) `{ media: { kind, url, path,
// caption?, filename?, mimeType? } }` for an attachment the browser
// uploaded to chat-media under account-<id>/groups/ (the same check and
// the same rebuilt link as /api/submission-groups/[id]/messages): a case
// writer replies through 115's guarded send. Send refusals and consent
// blocks are 409 with a code; a message WhatsApp accepted but whose row
// was not recorded is 200 `{ sent: true, recorded: false }`. Success is
// 201.
// ============================================================

import { after, NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { brainSink } from '@/lib/brain/sink';
import { canWriteCase } from '@/lib/cases/access';
import {
  assertUnderGroupSendLimit,
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  caseSendErrorResponse,
  loadCaseForCaller,
  requireCaseGroup,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { caseConversations, caseStore } from '@/lib/cases/server';
import {
  ownGroupMediaLink,
  parseOwnGroupMedia,
} from '@/lib/groups/own-group-media-url';
import {
  parseSendMedia,
  SG_TEXT_MAX,
  SgHttpError,
} from '@/lib/submission-groups/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';
import { loadNames } from '@/lib/submission-groups/view-refs';
import { toMessageView } from '@/lib/submission-groups/views';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
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
      waMode: read.waMode,
      truncated: read.truncated,
      messages: read.messages.map((m) => toMessageView(m, names)),
    });
  } catch (err) {
    return caseErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c, role } = await loadCaseForCaller(ctx, id, caseStore());
    if (!canWriteCase(role)) throw new CaseHttpError(403, 'Not allowed');
    await assertUnderGroupSendLimit(
      ctx.accountId,
      requireCaseGroup(c),
      ctx.userId
    );

    const body = await readJsonObject(request);
    const media = body ? parseSendMedia(body) : null;
    const objectPath = media
      ? parseOwnGroupMedia(media.url, media.path, ctx.accountId)
      : null;
    if (media && !objectPath)
      throw badRequest('media must be an upload to this group');
    const text = media
      ? (media.caption ?? '')
      : parseText(body?.text, SG_TEXT_MAX);
    if (text === null)
      throw badRequest(`text must be 1–${SG_TEXT_MAX} characters`);

    const conversations = caseConversations(ctx.accountId);
    const sent =
      media && objectPath
        ? await conversations.replyMedia(ctx.userId, c.id, {
            kind: media.kind,
            link: ownGroupMediaLink(objectPath),
            path: objectPath,
            caption: media.caption,
            filename: media.filename,
            mimeType: media.mimeType,
          })
        : await conversations.reply(ctx.userId, c.id, text);
    // The staff text (or caption), not the prefixed body the customer saw.
    if (text)
      after(() =>
        brainSink().record({
          kind: 'message',
          ref: {
            accountId: ctx.accountId,
            caseId: c.id,
            contactId: c.contactId ?? null,
            bankCode: c.bankCode ?? null,
            createdBy: ctx.userId,
          },
          messageId: sent.messageId,
          text,
        })
      );
    return NextResponse.json(
      { sent: true, recorded: true, ...sent },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return caseSendErrorResponse(err) ?? caseErrorResponse(err);
  }
}
