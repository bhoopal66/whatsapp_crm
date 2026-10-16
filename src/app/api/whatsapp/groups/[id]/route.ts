// ============================================================
// /api/whatsapp/groups/[id] — one WhatsApp group (migration 114).
// GET: anyone who can see it (RLS); `?refresh=1` re-reads it from
// Whapi, managers only. PATCH (name, description, settings) and DELETE
// (leave) need `whatsapp_group_can_manage`. Whapi first, then the
// service role persists what WhatsApp accepted.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { groupActionBlock, type GroupActionBlock } from '@/lib/groups/access';
import {
  callerCanManage,
  channelForGroup,
  GROUP_COLUMNS,
  GroupHttpError,
  groupErrorResponse,
  loadGroupForCaller,
  persistGroupSnapshot,
  supabaseAdmin,
} from '@/lib/groups/server';
import { parsePatch } from '@/lib/groups/requests';
import {
  parseGroupSettings,
  type GroupSettings,
  type WhatsappGroupRow,
} from '@/lib/groups/types';
import {
  getGroup,
  leaveGroup,
  updateGroupInfo,
  updateGroupSetting,
} from '@/lib/whatsapp/groups';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Each action and whether WhatsApp lets only a group admin do it. */
function adminOnlyActions(settings: GroupSettings) {
  return {
    send: settings.send_messages === 'admins',
    edit_info: settings.edit_group_info !== 'anyone',
    settings: true,
    members: true,
    invite: true,
    join_requests: true,
    leave: false,
  };
}

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    let group = await loadGroupForCaller(ctx, id);
    const canManage = await callerCanManage(ctx.supabase, id);

    if (new URL(request.url).searchParams.get('refresh') === '1') {
      if (!canManage) {
        throw new GroupHttpError(
          403,
          'not_allowed',
          "You can't manage this group"
        );
      }
      const channel = await channelForGroup(group);
      const fresh = await getGroup({ channel, groupId: group.wa_group_id });
      group = await persistGroupSnapshot(supabaseAdmin(), channel, fresh);
    }

    const [parts, mgrs] = await Promise.all([
      ctx.supabase
        .from('whatsapp_group_participants')
        .select('wa_id, contact_id, role, added_at')
        .eq('group_id', id)
        .order('role', { ascending: false }),
      ctx.supabase
        .from('whatsapp_group_managers')
        .select('user_id')
        .eq('group_id', id),
    ]);
    if (parts.error || mgrs.error) {
      throw new GroupHttpError(503, 'unavailable', 'Could not load the group');
    }
    const participants = (parts.data ?? []) as Array<{
      wa_id: string;
      contact_id: string | null;
      role: string;
      added_at: string;
    }>;
    const managerIds = (mgrs.data ?? []).map((m) => m.user_id as string);
    const contactIds = [
      ...new Set(participants.map((p) => p.contact_id).filter(Boolean)),
    ] as string[];

    // Contact names under the caller's RLS: a customer they cannot see
    // stays a bare number. Manager names are staff names, workspace-wide.
    const [contacts, profiles] = await Promise.all([
      contactIds.length
        ? ctx.supabase.from('contacts').select('id, name').in('id', contactIds)
        : Promise.resolve({ data: [] }),
      managerIds.length
        ? supabaseAdmin()
            .from('profiles')
            .select('user_id, full_name')
            .eq('account_id', ctx.accountId)
            .in('user_id', managerIds)
        : Promise.resolve({ data: [] }),
    ]);
    const nameOf = new Map(
      ((contacts.data ?? []) as Array<{ id: string; name: string | null }>).map(
        (c) => [c.id, c.name]
      )
    );
    const staffName = new Map(
      (
        (profiles.data ?? []) as Array<{
          user_id: string;
          full_name: string | null;
        }>
      ).map((p) => [p.user_id, p.full_name])
    );

    const facts = {
      createdBy: group.created_by,
      managerIds,
      channelId: group.channel_id,
      ourRole: group.our_role,
    };
    // `whatsapp_group_can_manage` already folded in can_use_channel.
    const usable = canManage && group.channel_id ? [group.channel_id] : [];
    const blocks: Record<string, GroupActionBlock | null> = {};
    for (const [action, adminOnly] of Object.entries(
      adminOnlyActions(parseGroupSettings(group.settings))
    )) {
      blocks[action] = groupActionBlock({
        role: ctx.role,
        userId: ctx.userId,
        group: facts,
        usableChannelIds: usable,
        adminOnly,
      });
    }

    return NextResponse.json({
      group,
      participants: participants.map((p) => ({
        ...p,
        contact_name:
          p.contact_id && nameOf.has(p.contact_id)
            ? nameOf.get(p.contact_id)
            : null,
        contact_id:
          p.contact_id && nameOf.has(p.contact_id) ? p.contact_id : null,
      })),
      managers: managerIds.map((user_id) => ({
        user_id,
        name: staffName.get(user_id) ?? null,
      })),
      canManage,
      blocks,
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

function requireActive(group: WhatsappGroupRow) {
  if (group.our_role === 'left') {
    throw new GroupHttpError(409, 'left', 'Your number has left this group');
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const patch = parsePatch(await request.json().catch(() => null));
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireActive(group);
    const current = parseGroupSettings(group.settings);
    const infoNeedsAdmin = current.edit_group_info !== 'anyone';
    const editsInfo =
      patch.name !== undefined || patch.description !== undefined;
    if (
      group.our_role !== 'admin' &&
      (Object.keys(patch.settings).length > 0 || (editsInfo && infoNeedsAdmin))
    ) {
      throw new GroupHttpError(
        403,
        'not_group_admin',
        "Your number isn't an admin of this group"
      );
    }

    const channel = await channelForGroup(group);
    const changes: Record<string, unknown> = {};
    let failure: unknown = null;
    try {
      if (editsInfo) {
        await updateGroupInfo({
          channel,
          groupId: group.wa_group_id,
          name: patch.name,
          description: patch.description,
        });
        if (patch.name !== undefined) changes.name = patch.name;
        if (patch.description !== undefined) {
          changes.description = patch.description || null;
        }
      }
      const settings = { ...current };
      for (const [setting, policy] of Object.entries(patch.settings)) {
        await updateGroupSetting({
          channel,
          groupId: group.wa_group_id,
          setting: setting as keyof GroupSettings,
          policy,
        });
        settings[setting as keyof GroupSettings] = policy;
        changes.settings = settings;
      }
    } catch (err) {
      // Keep what WhatsApp already accepted, then report the failure.
      failure = err;
    }

    let saved = group;
    if (Object.keys(changes).length > 0) {
      const { data, error } = await supabaseAdmin()
        .from('whatsapp_groups')
        .update(changes)
        .eq('id', group.id)
        .select(GROUP_COLUMNS)
        .single();
      if (error) throw error;
      saved = data as WhatsappGroupRow;
    }
    if (failure) throw failure;
    return NextResponse.json({ group: saved });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    if (group.our_role === 'left') return NextResponse.json({ group });
    const channel = await channelForGroup(group);
    await leaveGroup({ channel, groupId: group.wa_group_id });
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_groups')
      .update({ our_role: 'left' })
      .eq('id', group.id)
      .select(GROUP_COLUMNS)
      .single();
    if (error) throw error;
    return NextResponse.json({ group: data });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
