// ============================================================
// /api/submission-groups/[id]/messages — staff send into a Submission
// Group (115). POST `{ text }`; the service decides who may send (the
// open access row) and stores the row pending before the gateway call,
// so a gateway failure leaves it failed and answers a generic 502.
// At most GROUP_SEND_LIMIT sends per window per person per group
// (anti-ban), failed ones included.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  isOverSendLimit,
  isUuid,
  ownGroup,
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
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const group = ownGroup(
      isUuid(id) ? await submissionGroupStore().get(id) : null,
      ctx.accountId
    );
    const { text } = parseSendText(await request.json().catch(() => null));

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
      message = await submissionGroupService(ctx.accountId).sendFromCrm({
        groupId: group.id,
        userId: ctx.userId,
        text,
      });
    } catch (err) {
      const mapped = sendErrorFor(err);
      if (mapped.status === 502)
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
