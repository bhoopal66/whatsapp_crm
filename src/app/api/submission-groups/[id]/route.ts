// ============================================================
// GET /api/submission-groups/[id] — one Submission Group (115).
//
// ACTIVE: read through the caller's own RLS client, so a group they are
// not allowed to see answers 404; the open access list with names, the
// latest live messages (RLS hides post_end rows), `can_send` from the
// caller's open access row, else a held bank (163). ENDED: never readable through RLS, so the
// service role answers it, pinned to the caller's account and only when
// `sg_can_read` allows; never its messages (the archive is POST
// /archive, which audits every view), and the list as it stood at the end.
//
// The newest page of messages; `?before=<older_cursor>` answers the page
// before it, after the same access checks: `{ status, messages, has_more,
// older_cursor }` alone, and no message once the group has ENDED.
//
// `caseId` is the group's case (019a), or null when none was opened yet:
// looked up on the service role only once the checks above let the
// caller in, pinned to their account, and only when the caller holds a role
// on that case (case_role), so "Open case" is never a dead link.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
  assertSalesAccess,
} from '@/lib/auth/account';
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
import {
  canSend,
  isArchiveRole,
  isStaffLabel,
  type StaffLabel,
} from '@/lib/submission-groups/rules';
import { toMessage } from '@/lib/submission-groups/store';
import {
  loadBanks,
  loadNames,
  loadRefs,
} from '@/lib/submission-groups/view-refs';
import {
  canManageSubmissionGroups,
  cursorFilter,
  decodeMessageCursor,
  DETAIL_MESSAGE_LIMIT,
  messagePage,
  toAccessView,
  toDetailGroup,
  toMessageView,
} from '@/lib/submission-groups/views';

type Params = { params: Promise<{ id: string }> };

const MESSAGE_COLUMNS =
  'id, direction, sender_user_id, sender_wa_id, sender_kind, type, body, prefixed_body, media, wa_message_id, wa_timestamp, send_status, post_end, created_at, system_kind';

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    if (!isUuid(id)) throw new SgHttpError(404, GROUP_NOT_FOUND);
    const rawBefore = new URL(request.url).searchParams.get('before');
    const before = rawBefore === null ? null : decodeMessageCursor(rawBefore);
    const admin = supabaseAdmin();
    let group = ownGroup(
      await submissionGroupStore(admin).get(id),
      ctx.accountId
    );

    let access;
    let page: ReturnType<typeof messagePage> = {
      rows: [],
      hasMore: false,
      olderCursor: null,
    };
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
      let read = ctx.supabase
        .from('submission_group_messages')
        .select(MESSAGE_COLUMNS)
        .eq('group_id', group.id)
        .eq('post_end', false);
      if (before) read = read.or(cursorFilter('created_at', before));
      const { data, error } = await read
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(DETAIL_MESSAGE_LIMIT + 1);
      if (error) throw new Error(`submission_group_messages: ${error.message}`);
      page = messagePage((data ?? []) as Record<string, unknown>[]);
    }
    const messages = page.rows.map(toMessage);
    const paging = { has_more: page.hasMore, older_cursor: page.olderCursor };
    if (before) {
      const names = await loadNames(
        admin,
        ctx.accountId,
        messages.map((m) => m.senderUserId)
      );
      return NextResponse.json({
        status: group.status,
        messages: messages.map((m) => toMessageView(m, names)),
        ...paging,
      });
    }

    const [refs, names, caseId, banks] = await Promise.all([
      loadRefs(admin, ctx.accountId, [group]),
      loadNames(admin, ctx.accountId, [
        ...access.map((a) => a.userId),
        ...messages.map((m) => m.senderUserId),
      ]),
      loadCaseId(admin, ctx.accountId, group.id, ctx.userId),
      loadBanks(admin, ctx.accountId, [group.id]),
    ]);
    const active = group.status === 'ACTIVE';
    // 163: no open row, but a held bank can still make the caller a
    // coordinator of an ACTIVE group (sg_resolve_role decides).
    // 333: sendLabel adds 'owner' / 'admin' for an unlisted owner/admin;
    // my_label stays the staff-label part, send_label is what the server
    // will prefix a send with (ACTIVE only).
    const sendLabel = active
      ? await submissionGroupStore(admin).sendLabel(group.id, ctx.userId)
      : null;
    const myLabel: StaffLabel | null =
      access.find((a) => a.userId === ctx.userId)?.label ??
      (sendLabel !== null && isStaffLabel(sendLabel) ? sendLabel : null);
    return NextResponse.json({
      group: toDetailGroup(group, { ...refs, banks, myLabel }),
      send_label: sendLabel,
      access: access.map((a) => toAccessView(a, names)),
      messages: messages.map((m) => toMessageView(m, names)),
      ...paging,
      archive_available: !active,
      // 333: an owner/admin of the account sends to an ACTIVE group unlisted.
      can_send: canSend(
        isArchiveRole(ctx.role) ? ctx.role : myLabel,
        group.status,
        myLabel !== null
      ),
      can_manage: canManageSubmissionGroups(ctx.role),
      caseId,
    });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}

/** The group's case id in this account, or null when it has none. */
async function loadCaseId(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  groupId: string,
  userId: string
): Promise<string | null> {
  const { data, error } = await admin
    .from('cases')
    .select('id')
    .eq('group_id', groupId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`cases: ${error.message}`);
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') return null;
  // case_role (161) is narrower than the group's own access: someone on the
  // access list may hold no role on the case, and /cases/<id> would 404.
  // Only a definite "no role" hides the link; a failed read keeps it.
  const role = await admin.rpc('case_role', { p_case: id, p_user: userId });
  return !role.error && role.data == null ? null : id;
}
