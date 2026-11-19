// ============================================================
// /api/submission-groups/[id]/messages — staff send into a Submission
// Group (115). POST `{ text }`, or (210) `{ media: { kind, url, path,
// caption?, filename?, mimeType? } }` for an attachment the browser
// uploaded to chat-media under account-<id>/groups/ (checked by
// parseOwnGroupMedia; the gateway gets a link rebuilt on the public
// origin). The service decides who may send (the
// open access row) and stores the row pending before the gateway call,
// so a gateway failure leaves it failed and answers a generic 502. A
// send WhatsApp accepted but whose row could not be settled answers 202
// `{ error, sent: true }`: the text is gone, so nobody resends it.
// At most GROUP_SEND_LIMIT sends per window per person per group
// (anti-ban), failed ones included.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertSalesAccess,
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  ownGroupMediaLink,
  parseOwnGroupMedia,
} from '@/lib/groups/own-group-media-url';
import {
  isOverSendLimit,
  isUuid,
  ownGroup,
  parseSendMedia,
  parseSendText,
  sendErrorFor,
  sendWindowStart,
  SgHttpError,
} from '@/lib/submission-groups/http';
import {
  submissionGroupService,
  submissionGroupStore,
  supabaseAdmin,
} from '@/lib/submission-groups/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const group = ownGroup(
      isUuid(id) ? await submissionGroupStore().get(id) : null,
      ctx.accountId
    );
    const body: unknown = await request.json().catch(() => null);
    const media = parseSendMedia(body);
    // 210: an attachment must be the caller's own upload in chat-media; the
    // gateway is sent a link rebuilt on our public origin, never `url`.
    const objectPath = media
      ? parseOwnGroupMedia(media.url, media.path, ctx.accountId)
      : null;
    if (media && !objectPath)
      throw new SgHttpError(400, 'media must be an upload to this group');
    const text = media ? '' : parseSendText(body).text;

    const { count, error } = await supabaseAdmin()
      .from('submission_group_messages')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
      .eq('group_id', group.id)
      .eq('direction', 'out')
      .eq('sender_user_id', ctx.userId)
      .gte('created_at', sendWindowStart());
    if (error) {
      console.error('[submission-groups] send count failed', error);
      throw new SgHttpError(503, 'Could not check the send limit');
    }
    if (isOverSendLimit(count ?? 0))
      throw new SgHttpError(
        429,
        'You are sending to this group too fast; wait a minute'
      );

    let message;
    try {
      const service = submissionGroupService(ctx.accountId);
      message =
        media && objectPath
          ? await service.sendMediaFromCrm({
              groupId: group.id,
              userId: ctx.userId,
              kind: media.kind,
              link: ownGroupMediaLink(objectPath),
              path: objectPath,
              caption: media.caption,
              filename: media.filename,
              mimeType: media.mimeType,
            })
          : await service.sendFromCrm({
              groupId: group.id,
              userId: ctx.userId,
              text,
            });
    } catch (err) {
      const mapped = sendErrorFor(err);
      if (mapped.status === 502 || mapped.status === 202)
        console.error('[submission-groups] send failed', err);
      throw mapped;
    }
    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
