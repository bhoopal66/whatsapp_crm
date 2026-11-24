// ============================================================
// GET /api/submission-groups — the caller's Submission Groups (115).
// `?status=active|ended` (default active), `q` (submission ref or contact
// name), `bank` (a case bank code: only groups whose case is at it),
// `cursor` (opaque: the previous page's last sort time + id), `limit`
// (≤ 50) → `{ groups, next_cursor }`.
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
import {
  GROUP_COLUMNS,
  toGroup,
  type SubmissionGroup,
} from '@/lib/submission-groups/store';
import {
  loadBankHolding,
  loadBanks,
  loadLedGroups,
  loadRefs,
  loadUnread,
  matchingContactIds,
} from '@/lib/submission-groups/view-refs';
import {
  BANK_SCAN_BATCH,
  canManageSubmissionGroups,
  cursorFilter,
  encodeCursor,
  impliedLabel,
  myLabelOf,
  nextCursor,
  parseListQuery,
  scanVisiblePage,
  searchFilter,
  sortColumn,
  toListItem,
  type AccessRow,
} from '@/lib/submission-groups/views';

/** The group's case (one per group, 122), named so the embed is never ambiguous. */
const BANK_EMBED = 'cases!cases_group_fkey!inner(bank_code)';

type Row = Record<string, unknown>;

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
    const search = query.search
      ? searchFilter(
          query.search,
          await matchingContactIds(admin, ctx.accountId, query.search)
        )
      : null;

    let rows: Row[];
    let next: string | null;
    if (query.bank && !ended) {
      // cases' RLS (case_role) is narrower than the groups' own: it ignores
      // a group's access list, so an embed through the caller's client would
      // drop groups they can see. The bank is matched on the service role
      // instead, and the caller's RLS decides, batch by batch, which of
      // those groups they see.
      const bank = query.bank;
      const page = await scanVisiblePage({
        column,
        cursor: query.cursor,
        limit: query.limit,
        scan: async (after) => {
          let q = admin
            .from('submission_groups')
            .select(`${GROUP_COLUMNS}, ${BANK_EMBED}`)
            .eq('account_id', ctx.accountId)
            .eq('status', 'ACTIVE')
            .eq('cases.bank_code', bank);
          if (after) q = q.or(cursorFilter(column, after));
          if (search) q = q.or(search);
          const { data, error } = await q
            .order(column, { ascending: false })
            .order('id', { ascending: false })
            .limit(BANK_SCAN_BATCH);
          if (error) throw new Error(`submission_groups: ${error.message}`);
          return (data ?? []) as unknown as Row[];
        },
        visible: async (ids) => {
          const { data, error } = await ctx.supabase
            .from('submission_groups')
            .select('id')
            .eq('account_id', ctx.accountId)
            .in('id', ids);
          if (error) throw new Error(`submission_groups: ${error.message}`);
          return new Set(((data ?? []) as Row[]).map((r) => String(r.id)));
        },
      });
      rows = page.rows;
      next = page.next ? encodeCursor(page.next) : null;
    } else {
      const embeds = [
        ...(narrow ? ['submission_group_access!inner(user_id)'] : []),
        ...(query.bank ? [BANK_EMBED] : []),
      ];
      let q = (ended ? admin : ctx.supabase)
        .from('submission_groups')
        .select([GROUP_COLUMNS, ...embeds].join(', '))
        .eq('account_id', ctx.accountId)
        .eq('status', query.status);
      if (narrow) q = q.eq('submission_group_access.user_id', ctx.userId);
      // Only ENDED reaches this with a bank: read on the service role, where
      // cases' RLS does not cut the embed down.
      if (query.bank) q = q.eq('cases.bank_code', query.bank);
      if (query.cursor) q = q.or(cursorFilter(column, query.cursor));
      if (search) q = q.or(search);
      const { data, error } = await q
        .order(column, { ascending: false })
        .order('id', { ascending: false })
        .limit(query.limit);
      if (error) throw new Error(`submission_groups: ${error.message}`);
      rows = (data ?? []) as unknown as Row[];
      next = nextCursor(rows, query.limit, query.status);
    }
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

    const unread = await loadUnread(ctx.supabase);
    // The sidebar counts a customer's message in an ENDED group (267), so the
    // first page of the plain Active list carries those groups too (308).
    const endedUnread =
      ended || query.cursor || query.search || query.bank
        ? []
        : await loadEndedUnread(admin, ctx, groups, unread);
    const listed = [...groups, ...endedUnread];
    const [refs, banks] = await Promise.all([
      loadRefs(admin, ctx.accountId, listed),
      loadBanks(
        admin,
        ctx.accountId,
        listed.map((g) => g.id)
      ),
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
          banks,
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
      ended_unread: endedUnread.map((g) =>
        toListItem(g, {
          ...refs,
          banks,
          myLabel: null,
          unread: unread.get(g.id),
        })
      ),
      next_cursor: next,
    });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}

/**
 * The ENDED groups among the caller's unread counts, newest end first.
 * `sg_unread_by_group` already answers only for groups they may read;
 * sg_can_read decides again, as for every ENDED group.
 */
async function loadEndedUnread(
  admin: ReturnType<typeof supabaseAdmin>,
  ctx: { accountId: string; userId: string },
  listed: readonly { id: string }[],
  unread: ReadonlyMap<string, number>
): Promise<SubmissionGroup[]> {
  const have = new Set(listed.map((g) => g.id));
  const ids = [...unread.keys()].filter((id) => !have.has(id));
  if (!ids.length) return [];
  const { data, error } = await admin
    .from('submission_groups')
    .select(GROUP_COLUMNS)
    .eq('account_id', ctx.accountId)
    .eq('status', 'ENDED')
    .in('id', ids)
    .order('ended_at', { ascending: false });
  if (error) throw new Error(`submission_groups: ${error.message}`);
  const store = submissionGroupStore(admin);
  const groups = ((data ?? []) as unknown as Row[]).map(toGroup);
  const allowed = await Promise.all(
    groups.map((g) => store.canRead(g.id, ctx.userId))
  );
  return groups.filter((_, i) => allowed[i]);
}
