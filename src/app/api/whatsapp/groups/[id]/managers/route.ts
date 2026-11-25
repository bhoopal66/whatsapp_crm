// ============================================================
// /api/whatsapp/groups/[id]/managers — who works a group (114).
// GET is open to anyone who can see the group. PUT takes the new set and
// the set it was edited from (`base`): only `base − userIds` is dropped and
// only `userIds − base` added, so a colleague added meanwhile stays. Without
// `base` (an older tab) it replaces the whole set. It is for owners/admins and the group's creator only; every new
// id must be a live, non-guest member of the account (400
// `invalid_manager`). A manager who no longer is one (deactivated) is
// dropped from the set instead: the picker sends them back unseen, and
// refusing them would block every save of the group. The creator's row is always kept, so a group is
// never left without the person who made it.
//
// Managers and their saved numbers are linked (2026-11-21): once the
// rows are written, a new manager's saved number (`staff_saved_phone`,
// migration 219) is added to the WhatsApp group and a dropped
// manager's is removed (`staff_removal_phone`, 299: a deactivated or
// demoted person's too); a new manager with no saved number just sends
// from the app, a dropped one is reported (`no_saved_number`): their
// phone may still be in the group. This is best effort after the write
// and never fails it: the answer's `numbers` says what happened,
// including `refused` (WhatsApp wouldn't add them: share the invite
// link) and the group blocks (number_removed, left, not_group_admin).
// Our own number is never touched. The reverse direction is a trigger
// in 219.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { canViewAllGroups } from '@/lib/auth/roles';
import { diffManagers } from '@/lib/groups/manager-numbers';
import { wantedManagers } from '@/lib/groups/manager-set';
import { syncManagerNumbers } from '@/lib/groups/manager-sync';
import { parseManagerSet } from '@/lib/groups/member-requests';
import {
  GroupHttpError,
  callerCanManage,
  groupErrorResponse,
  loadGroupForCaller,
  supabaseAdmin,
} from '@/lib/groups/server';
import { groupDeadline } from '@/lib/whatsapp/groups';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };
type Admin = ReturnType<typeof supabaseAdmin>;

const unavailable = () =>
  new GroupHttpError(503, 'unavailable', 'Could not load the managers');

async function readManagers(
  admin: Admin,
  accountId: string,
  groupId: string,
  creatorId: string | null
) {
  const { data, error } = await admin
    .from('whatsapp_group_managers')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('group_id', groupId);
  if (error) {
    console.error('[groups] managers read failed', error);
    throw unavailable();
  }
  const ids = [
    ...new Set([
      ...((data ?? []) as { user_id: string }[]).map((r) => r.user_id),
      ...(creatorId ? [creatorId] : []),
    ]),
  ];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: people, error: nameError } = await admin
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', accountId)
      .in('user_id', ids);
    if (nameError) {
      console.error('[groups] manager names failed', nameError);
      throw unavailable();
    }
    for (const p of (people ?? []) as {
      user_id: string;
      full_name: string | null;
    }[]) {
      if (p.full_name) names.set(p.user_id, p.full_name);
    }
  }
  return ids
    .map((userId) => ({
      userId,
      name: names.get(userId) ?? '',
      isCreator: userId === creatorId,
    }))
    .sort((a, b) => Number(b.isCreator) - Number(a.isCreator));
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const group = await loadGroupForCaller(ctx, id);
    const managers = await readManagers(
      supabaseAdmin(),
      ctx.accountId,
      group.id,
      group.created_by
    );
    return NextResponse.json({ managers });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  const deadline = groupDeadline();
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { userIds, base } = parseManagerSet(
      await request.json().catch(() => null)
    );
    const group = await loadGroupForCaller(ctx, id);
    // The creator keeps this only while they can still manage the group
    // (an agent whose access lapsed must not edit its managers).
    const allowed = canViewAllGroups(ctx.role)
      ? true
      : group.created_by === ctx.userId &&
        (await callerCanManage(ctx.supabase, id));
    if (!allowed) {
      throw new GroupHttpError(
        403,
        'not_allowed',
        "Only an admin or the group's creator can change its managers"
      );
    }
    const admin = supabaseAdmin();
    const { data: current, error: readError } = await admin
      .from('whatsapp_group_managers')
      .select('user_id')
      .eq('account_id', ctx.accountId)
      .eq('group_id', group.id);
    if (readError) {
      console.error('[groups] managers read failed', readError);
      throw unavailable();
    }
    const before = ((current ?? []) as { user_id: string }[]).map(
      (r) => r.user_id
    );
    let wanted = wantedManagers({ before, userIds, base });
    if (wanted.length > 0) {
      const { data, error } = await admin
        .from('profiles')
        .select('user_id')
        .eq('account_id', ctx.accountId)
        .is('deactivated_at', null)
        .neq('account_role', 'bank_guest')
        .in('user_id', wanted);
      if (error) {
        console.error('[groups] manager check failed', error);
        throw unavailable();
      }
      const live = new Set(
        ((data ?? []) as { user_id: string }[]).map((r) => r.user_id)
      );
      if (wanted.some((u) => !live.has(u) && !before.includes(u))) {
        throw new GroupHttpError(
          400,
          'invalid_manager',
          'Managers must be active staff of this workspace'
        );
      }
      wanted = wanted.filter((u) => live.has(u));
    }

    const keep = new Set(wanted);
    const drop = before.filter((u) => !keep.has(u) && u !== group.created_by);
    if (drop.length > 0) {
      const { error } = await admin
        .from('whatsapp_group_managers')
        .delete()
        .eq('account_id', ctx.accountId)
        .eq('group_id', group.id)
        .in('user_id', drop);
      if (error) {
        console.error('[groups] manager removal failed', error);
        throw new GroupHttpError(
          503,
          'unavailable',
          'Could not save the managers'
        );
      }
    }
    if (wanted.length > 0) {
      const { error } = await admin.from('whatsapp_group_managers').upsert(
        wanted.map((user_id) => ({
          group_id: group.id,
          account_id: ctx.accountId,
          user_id,
        })),
        { onConflict: 'group_id,user_id', ignoreDuplicates: true }
      );
      if (error) {
        console.error('[groups] manager write failed', error);
        throw new GroupHttpError(
          503,
          'unavailable',
          'Could not save the managers'
        );
      }
    }
    const { added, removed } = diffManagers({
      before,
      after: [...wanted, ...(group.created_by ? [group.created_by] : [])],
      creatorId: group.created_by,
    });
    const numbers = await syncManagerNumbers(
      admin,
      group,
      added,
      removed,
      deadline,
      ctx.userId
    );
    const managers = await readManagers(
      admin,
      ctx.accountId,
      group.id,
      group.created_by
    );
    return NextResponse.json({ managers, numbers });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
