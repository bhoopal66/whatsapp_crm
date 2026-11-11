// ============================================================
// GET /api/submission-groups — the caller's Submission Groups (115).
// `?status=active|ended` (default active), `q` (submission ref or contact
// name), `cursor` (opaque: the previous page's last sort time + id),
// `limit` (≤ 50) → `{ groups, next_cursor }`.
//
// ACTIVE groups are read through the caller's own RLS client: the
// policy hands them the groups whose open access list they are on, or
// every ACTIVE group for owner/admin. ENDED groups are never readable
// through RLS, so their metadata comes from the service role pinned to
// the caller's account, keeping only the rows `sg_can_read` allows
// (owner/admin all; a coordinator/team lead within the supervisor
// window). No messages here.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
  assertSalesAccess,
} from '@/lib/auth/account';
import { SgHttpError } from '@/lib/submission-groups/http';
import {
  submissionGroupStore,
  supabaseAdmin,
} from '@/lib/submission-groups/server';
import { GROUP_COLUMNS, toGroup } from '@/lib/submission-groups/store';
import {
  loadBankHolding,
  loadLedGroups,
  loadRefs,
  loadUnread,
  matchingContactIds,
} from '@/lib/submission-groups/view-refs';
import {
  canManageSubmissionGroups,
  cursorFilter,
  impliedLabel,
  myLabelOf,
  nextCursor,
  parseListQuery,
  searchFilter,
  sortColumn,
  toListItem,
  type AccessRow,
} from '@/lib/submission-groups/views';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const query = parseListQuery(new URL(request.url).searchParams);
    const admin = supabaseAdmin();
    const ended = query.status === 'ENDED';
    // Below admin, an ENDED group is readable only by someone on its list
    // at the end, so only those are scanned; sg_can_read still decides.
    const narrow = ended && !canManageSubmissionGroups(ctx.role);

    const column = sortColumn(query.status);
    let q = (ended ? admin : ctx.supabase)
      .from('submission_groups')
      .select(
        narrow
          ? `${GROUP_COLUMNS}, submission_group_access!inner(user_id)`
          : GROUP_COLUMNS
      )
      .eq('account_id', ctx.accountId)
      .eq('status', query.status);
    if (narrow) q = q.eq('submission_group_access.user_id', ctx.userId);
    if (query.cursor) q = q.or(cursorFilter(column, query.cursor));
    if (query.search) {
      const contactIds = await matchingContactIds(
        admin,
        ctx.accountId,
        query.search
      );
      q = q.or(searchFilter(query.search, contactIds));
    }
    const { data, error } = await q
      .order(column, { ascending: false })
      .order('id', { ascending: false })
      .limit(query.limit);
    if (error) throw new Error(`submission_groups: ${error.message}`);

    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const scanned = rows.map(toGroup);
    let groups = scanned;
    if (ended) {
      const store = submissionGroupStore(admin);
      const allowed = await Promise.all(
        scanned.map((g) => store.canRead(g.id, ctx.userId))
      );
      groups = scanned.filter((_, i) => allowed[i]);
    }

    let mine: AccessRow[] = [];
    if (groups.length) {
      const ids = groups.map((g) => g.id);
      const access = ended
        ? admin
            .from('submission_group_access')
            .select('group_id, label, removed_at')
            .eq('account_id', ctx.accountId)
            .eq('user_id', ctx.userId)
            .in('group_id', ids)
        : ctx.supabase
            .from('submission_group_access')
            .select('group_id, label, removed_at')
            .eq('user_id', ctx.userId)
            .is('removed_at', null)
            .in('group_id', ids);
      const res = await access;
      if (res.error)
        throw new Error(`submission_group_access: ${res.error.message}`);
      mine = (res.data ?? []) as AccessRow[];
    }

    // An ENDED group has no unread count; 173 counts ACTIVE groups only.
    const [refs, unread] = await Promise.all([
      loadRefs(admin, ctx.accountId, groups),
      ended ? new Map<string, number>() : loadUnread(ctx.supabase),
    ]);
    // With no open row on an ACTIVE group, a leader of the case's agent
    // reads it as team lead (173) and a holder of its bank as coordinator
    // (163).
    const unlabelled = groups
      .filter((g) => myLabelOf(g, mine) === null)
      .map((g) => g.id);
    const [holding, led] = ended
      ? [null, new Set<string>()]
      : await Promise.all([
          loadBankHolding(admin, ctx.accountId, ctx.userId, unlabelled),
          ctx.role === 'team_leader'
            ? loadLedGroups(admin, ctx.userId, unlabelled)
            : new Set<string>(),
        ]);
    return NextResponse.json({
      groups: groups.map((g) =>
        toListItem(g, {
          ...refs,
          myLabel:
            myLabelOf(g, mine) ??
            (holding
              ? impliedLabel(
                  g,
                  ctx.role,
                  led,
                  holding.held,
                  holding.bankByGroup
                )
              : null),
          unread: unread.get(g.id),
        })
      ),
      next_cursor: nextCursor(rows, query.limit, query.status),
    });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
