// ============================================================
// GET /api/submission-groups/[id] — one Submission Group (115).
//
// ACTIVE: read through the caller's own RLS client, so a group they are
// not allowed to see answers 404; the open access list with names, the
// latest live messages (RLS hides post_end rows), `can_send` from the
// caller's open access row. ENDED: never readable through RLS, so the
// service role answers it, pinned to the caller's account and only when
// `sg_can_read` allows; never its messages (the archive is POST
// /archive, which audits every view), and the list as it stood at the end.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  GROUP_NOT_FOUND,
  isUuid,
  ownGroup,
  SgHttpError,
} from '@/lib/submission-groups/http';
import {
  submissionGroupStore,
  supabaseAdmin,
} from '@/lib/submission-groups/server';
import { toMessage } from '@/lib/submission-groups/store';
import { loadNames, loadRefs } from '@/lib/submission-groups/view-refs';
import {
  canManageSubmissionGroups,
  DETAIL_MESSAGE_LIMIT,
  toAccessView,
  toDetailGroup,
  toMessageView,
} from '@/lib/submission-groups/views';

type Params = { params: Promise<{ id: string }> };

const MESSAGE_COLUMNS =
  'id, direction, sender_user_id, sender_wa_id, sender_kind, type, body, prefixed_body, media, wa_message_id, wa_timestamp, send_status, post_end, created_at';

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!isUuid(id)) throw new SgHttpError(404, GROUP_NOT_FOUND);
    const admin = supabaseAdmin();
    let group = ownGroup(
      await submissionGroupStore(admin).get(id),
      ctx.accountId
    );

    let access;
    let messages: ReturnType<typeof toMessage>[] = [];
    if (group.status === 'ENDED') {
      const store = submissionGroupStore(admin);
      if (!(await store.canRead(group.id, ctx.userId)))
        throw new SgHttpError(404, GROUP_NOT_FOUND);
      access = await store.listAccess(group);
    } else {
      // RLS decides: an ACTIVE group the caller may not see is not found.
      const mine = submissionGroupStore(ctx.supabase);
      const visible = await mine.get(group.id);
      if (!visible || visible.accountId !== ctx.accountId)
        throw new SgHttpError(404, GROUP_NOT_FOUND);
      group = visible;
      access = await mine.listAccess(group);
      const { data, error } = await ctx.supabase
        .from('submission_group_messages')
        .select(MESSAGE_COLUMNS)
        .eq('group_id', group.id)
        .eq('post_end', false)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(DETAIL_MESSAGE_LIMIT);
      if (error) throw new Error(`submission_group_messages: ${error.message}`);
      messages = ((data ?? []) as Record<string, unknown>[])
        .map(toMessage)
        .reverse();
    }

    const [refs, names] = await Promise.all([
      loadRefs(admin, ctx.accountId, [group]),
      loadNames(admin, ctx.accountId, [
        ...access.map((a) => a.userId),
        ...messages.map((m) => m.senderUserId),
      ]),
    ]);
    const myLabel = access.find((a) => a.userId === ctx.userId)?.label ?? null;
    const active = group.status === 'ACTIVE';
    return NextResponse.json({
      group: toDetailGroup(group, { ...refs, myLabel }),
      access: access.map((a) => toAccessView(a, names)),
      messages: messages.map((m) => toMessageView(m, names)),
      archive_available: !active,
      can_send: active && myLabel !== null,
      can_manage: canManageSubmissionGroups(ctx.role),
    });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
