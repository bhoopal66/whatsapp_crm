// ============================================================
// /api/whatsapp/groups/[id]/managers — who works a group (114).
// GET is open to anyone who can see the group. PUT replaces the whole
// set and is for owners/admins and the group's creator only; every id
// must be a live, non-guest member of the account (400
// `invalid_manager`). The creator's row is always kept, so a group is
// never left without the person who made it.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canViewAllGroups } from '@/lib/auth/roles';
import { parseManagerSet } from '@/lib/groups/member-requests';
import {
  GroupHttpError,
  callerCanManage,
  groupErrorResponse,
  loadGroupForCaller,
  supabaseAdmin,
} from '@/lib/groups/server';

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
    const ctx = await getCurrentAccount();
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
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { userIds } = parseManagerSet(await request.json().catch(() => null));
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
    const wanted = [...new Set(userIds)];
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
      if (wanted.some((u) => !live.has(u))) {
        throw new GroupHttpError(
          400,
          'invalid_manager',
          'Managers must be active staff of this workspace'
        );
      }
    }

    const keep = new Set(wanted);
    const { data: current, error: readError } = await admin
      .from('whatsapp_group_managers')
      .select('user_id')
      .eq('account_id', ctx.accountId)
      .eq('group_id', group.id);
    if (readError) {
      console.error('[groups] managers read failed', readError);
      throw unavailable();
    }
    const drop = ((current ?? []) as { user_id: string }[])
      .map((r) => r.user_id)
      .filter((u) => !keep.has(u) && u !== group.created_by);
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
    const managers = await readManagers(
      admin,
      ctx.accountId,
      group.id,
      group.created_by
    );
    return NextResponse.json({ managers });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
