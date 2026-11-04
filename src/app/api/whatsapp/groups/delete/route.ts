// ============================================================
// POST /api/whatsapp/groups/delete — delete groups for good (owner/
// admin). Body `{ ids: string[] }`, 1..100 UUIDs. Answers `{ deleted,
// skipped, refused, failed }`; `failed` is `{ id, reason }`. Child
// tables (participants, managers, invites, messages) cascade.
//
// - A submission group is `refused` and never touched, even when Sync
//   mirrored it here. `submission_groups` is read before anything else
//   and a failed read stops the request.
// - Still in the group: leave on WhatsApp FIRST, at most
//   MAX_JOINED_DELETES per call, the rest in `failed`. A failed leave
//   writes nothing. A leave 404 counts as left only if the number then
//   probes as authorized: a wrong token is a 404 too. The last leave
//   starts by 30 s and ends by 45 s, the probe by 50 s, inside
//   `maxDuration` with 10 s to save and answer.
// - Then the tombstone, then the row. Tombstone first: a failed delete
//   leaves a row a retry can finish, never a deleted group a webhook or
//   Sync can recreate. A row with no number has no tombstone (its key
//   needs the number, and a new number has a new id anyway).
// - A group already `left` keeps `our_role = 'left'` on the DELETE
//   itself, so one re-joined after the read survives and its tombstone
//   is withdrawn. Every DELETE carries the account filter.
//
// `DELETE /api/whatsapp/groups/[id]` is LEAVE, not this.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { planGroupDelete, type GroupToDelete } from '@/lib/groups/delete';
import {
  channelForGroup,
  groupFailure,
  GroupHttpError,
  isAlreadyOutOfGroup,
  isUuid,
  leaveFailureReason,
  submissionGroupIds,
  supabaseAdmin,
} from '@/lib/groups/server';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  GROUP_CALL_TIMEOUT_MS,
  groupDeadline,
  leaveGroup,
  withinBudget,
} from '@/lib/whatsapp/groups';

export const maxDuration = 60;

export const MAX_DELETE_IDS = 100;

const NOT_SAVED = "The group couldn't be removed; try again";
const LEFT_NOT_SAVED =
  "Your number left the group, but it couldn't be removed; try again";
const OVER_LIMIT = 'Too many groups at once; delete this one again';

function parseIds(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const ids = (raw as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (ids.length > MAX_DELETE_IDS || !ids.every(isUuid)) return null;
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

type Admin = ReturnType<typeof supabaseAdmin>;
type Ctx = { accountId: string; userId: string };

/** Upserts the rows' tombstones; answers the error, if any. */
async function writeTombstones(
  admin: Admin,
  ctx: Ctx,
  rows: GroupToDelete[]
): Promise<unknown> {
  const marks = rows.flatMap((r) =>
    r.channel_id
      ? [
          {
            account_id: ctx.accountId,
            channel_id: r.channel_id,
            wa_group_id: r.wa_group_id,
            deleted_at: new Date().toISOString(),
            deleted_by: ctx.userId,
          },
        ]
      : []
  );
  if (marks.length === 0) return null;
  const { error } = await admin
    .from('whatsapp_group_tombstones')
    .upsert(marks, { onConflict: 'account_id,channel_id,wa_group_id' });
  return error;
}

/**
 * A left group the DELETE did not take: re-joined, so it stays and must
 * keep syncing. One already removed by someone else keeps its tombstone.
 */
async function withdrawTombstones(
  admin: Admin,
  ctx: Ctx,
  rows: GroupToDelete[]
): Promise<void> {
  const still = await admin
    .from('whatsapp_groups')
    .select('id')
    .eq('account_id', ctx.accountId)
    .in(
      'id',
      rows.map((r) => r.id)
    );
  if (still.error) {
    console.error('[groups] re-joined check failed', still.error);
    return;
  }
  const alive = new Set(
    ((still.data ?? []) as Array<{ id: string }>).map((r) => r.id)
  );
  for (const row of rows) {
    if (!alive.has(row.id) || !row.channel_id) continue;
    const { error } = await admin
      .from('whatsapp_group_tombstones')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('channel_id', row.channel_id)
      .eq('wa_group_id', row.wa_group_id);
    if (error) console.error('[groups] tombstone withdraw failed', error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const ids = parseIds(await request.json().catch(() => null));
    if (!ids) {
      return NextResponse.json(
        { error: `ids must be 1 to ${MAX_DELETE_IDS} group ids` },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const budget = { deadline: groupDeadline() };
    const found = await admin
      .from('whatsapp_groups')
      .select('id, channel_id, wa_group_id, our_role')
      .eq('account_id', ctx.accountId)
      .in('id', ids);
    if (found.error) throw found.error;
    const byId = new Map(
      ((found.data ?? []) as GroupToDelete[]).map((g) => [g.id, g])
    );
    const rows = ids.flatMap((id) => byId.get(id) ?? []);
    const plan = planGroupDelete(
      rows,
      await submissionGroupIds(
        admin,
        ctx.accountId,
        rows.map((r) => r.wa_group_id)
      )
    );

    const deleted: string[] = [];
    const failed = plan.overLimit.map((g) => ({
      id: g.id,
      reason: OVER_LIMIT,
    }));

    if (plan.left.length > 0) {
      const markError = await writeTombstones(admin, ctx, plan.left);
      const del = markError
        ? null
        : await admin
            .from('whatsapp_groups')
            .delete()
            .eq('account_id', ctx.accountId)
            .eq('our_role', 'left')
            .in(
              'id',
              plan.left.map((g) => g.id)
            )
            .select('id');
      if (!del || del.error) {
        console.error('[groups] delete failed', markError ?? del?.error);
        for (const g of plan.left) failed.push({ id: g.id, reason: NOT_SAVED });
      } else {
        const gone = new Set(
          ((del.data ?? []) as Array<{ id: string }>).map((g) => g.id)
        );
        deleted.push(...gone);
        const kept = plan.left.filter((g) => !gone.has(g.id));
        if (kept.length > 0) await withdrawTombstones(admin, ctx, kept);
      }
    }

    if (plan.orphaned.length > 0) {
      const del = await admin
        .from('whatsapp_groups')
        .delete()
        .eq('account_id', ctx.accountId)
        .is('channel_id', null)
        .in(
          'id',
          plan.orphaned.map((g) => g.id)
        )
        .select('id');
      if (del.error) {
        console.error('[groups] delete failed', del.error);
        for (const g of plan.orphaned) {
          failed.push({ id: g.id, reason: NOT_SAVED });
        }
      } else {
        deleted.push(
          ...((del.data ?? []) as Array<{ id: string }>).map((g) => g.id)
        );
      }
    }

    const channels = new Map<string, Promise<WhatsAppChannel>>();
    const channelOf = (g: GroupToDelete) => {
      const key = g.channel_id as string;
      if (!channels.has(key)) {
        channels.set(
          key,
          channelForGroup({ account_id: ctx.accountId, channel_id: key })
        );
      }
      return channels.get(key) as Promise<WhatsAppChannel>;
    };

    for (const group of plan.joined) {
      if (!withinBudget(budget, GROUP_CALL_TIMEOUT_MS)) {
        failed.push({
          id: group.id,
          reason: groupFailure('time_budget').error,
        });
        continue;
      }
      try {
        const channel = await channelOf(group);
        // The health check saw this number fail: its 404s prove nothing.
        if (channel.status === 'disconnected') {
          throw new GroupHttpError(
            503,
            'channel_disconnected',
            groupFailure('channel_disconnected').error
          );
        }
        await leaveGroup({
          channel,
          groupId: group.wa_group_id,
          timeoutMs: GROUP_CALL_TIMEOUT_MS,
        }).catch(async (err) => {
          if (!(await isAlreadyOutOfGroup(err, channel))) throw err;
        });
      } catch (err) {
        console.error('[groups] leave before delete failed', group.id, err);
        failed.push({ id: group.id, reason: leaveFailureReason(err) });
        continue;
      }

      const markError = await writeTombstones(admin, ctx, [group]);
      const del = markError
        ? null
        : await admin
            .from('whatsapp_groups')
            .delete()
            .eq('account_id', ctx.accountId)
            .eq('id', group.id)
            .select('id');
      if (!del || del.error) {
        console.error('[groups] delete failed', markError ?? del?.error);
        // We are out: a retry must not depend on leaving a second time.
        const upd = await admin
          .from('whatsapp_groups')
          .update({ our_role: 'left' })
          .eq('account_id', ctx.accountId)
          .eq('id', group.id);
        if (upd.error) console.error('[groups] mark left failed', upd.error);
        failed.push({ id: group.id, reason: LEFT_NOT_SAVED });
      } else if ((del.data ?? []).length > 0) {
        deleted.push(group.id);
      }
    }

    const refused = plan.refused.map((g) => g.id);
    const settled = new Set([
      ...deleted,
      ...refused,
      ...failed.map((f) => f.id),
    ]);
    return NextResponse.json({
      deleted,
      skipped: ids.filter((id) => !settled.has(id)),
      refused,
      failed,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
