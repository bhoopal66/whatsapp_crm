// ============================================================
// /api/whatsapp/groups — the group list and group creation
// (migration 114).
// GET: the groups the caller's RLS shows, latest activity first, each
// with its number's display name and whether the caller manages it.
// POST: create a group on a Whapi number the caller may use
// (`whatsapp_group_can_create`). WhatsApp first; the service role then
// persists what WhatsApp made, and description, settings and managers
// follow best-effort, reported as `warnings`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { screenRecipients } from '@/lib/groups/recipients';
import { nameSearchPattern, parseCreate } from '@/lib/groups/requests';
import {
  GROUP_COLUMNS,
  GroupHttpError,
  groupErrorResponse,
  loadWhapiChannel,
  persistGroupSnapshot,
  supabaseAdmin,
} from '@/lib/groups/server';
import type {
  GroupSetting,
  GroupSettings,
  WhatsappGroupRow,
} from '@/lib/groups/types';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  createGroup,
  type CreateGroupOutcome,
  getGroup,
  groupDeadline,
  updateGroupInfo,
  updateGroupSetting,
  withinBudget,
} from '@/lib/whatsapp/groups';

export const maxDuration = 60;

const LIST_LIMIT = 500;

const unavailable = (what: string) =>
  new GroupHttpError(503, 'unavailable', `Could not ${what}`);

/** `SETOF uuid` from PostgREST: bare scalars, or one-key rows on older versions. */
function idSet(data: unknown): Set<string> {
  const out = new Set<string>();
  for (const v of Array.isArray(data) ? data : []) {
    if (typeof v === 'string') out.add(v);
    else if (v && typeof v === 'object') {
      const first = Object.values(v)[0];
      if (typeof first === 'string') out.add(first);
    }
  }
  return out;
}

/**
 * What to store for a group just made. Whapi's create response lists
 * only the first batch; later batches went in by separate calls, so
 * saving that response would delete the rows their webhooks wrote and
 * reset the count. Re-read the group when anyone was added after it;
 * if that fails (or time is short), merge in who we know was added.
 */
async function createdSnapshot(
  channel: WhatsAppChannel,
  outcome: CreateGroupOutcome,
  deadline: number
): Promise<CreateGroupOutcome['group']> {
  const listed = new Set(outcome.group.participants.map((p) => p.waId));
  const extra = outcome.added.filter((a) => a.waId && !listed.has(a.waId));
  if (extra.length === 0) return outcome.group;
  if (withinBudget({ deadline })) {
    try {
      return await getGroup({ channel, groupId: outcome.group.id });
    } catch (err) {
      console.error('[groups] re-read after create failed', err);
    }
  }
  const participants = [
    ...outcome.group.participants,
    ...extra.map((a) => ({ ...a, role: 'member' as const })),
  ];
  return {
    ...outcome.group,
    participants,
    participantsCount: Math.max(
      outcome.group.participantsCount ?? 0,
      participants.length
    ),
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const pattern = nameSearchPattern(
      new URL(request.url).searchParams.get('q')
    );
    let query = ctx.supabase
      .from('whatsapp_groups')
      .select(GROUP_COLUMNS)
      .eq('account_id', ctx.accountId);
    if (pattern) query = query.ilike('name', pattern);
    const [list, manageable] = await Promise.all([
      query
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('name', { ascending: true })
        .limit(LIST_LIMIT),
      ctx.supabase.rpc('whatsapp_group_manageable_ids'),
    ]);
    if (list.error || manageable.error) {
      console.error('[groups] list failed', list.error ?? manageable.error);
      throw unavailable('load the groups');
    }
    const groups = (list.data ?? []) as unknown as WhatsappGroupRow[];
    const canManage = idSet(manageable.data);

    // Display columns only: the caller may not read whatsapp_config,
    // and its tokens never leave the server.
    const channelIds = [
      ...new Set(groups.map((g) => g.channel_id).filter(Boolean)),
    ] as string[];
    const channelOf = new Map<
      string,
      { id: string; name: string; phone: string | null }
    >();
    if (channelIds.length > 0) {
      const { data, error } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('id, label, waba_id')
        .eq('account_id', ctx.accountId)
        .in('id', channelIds);
      if (error) {
        console.error('[groups] channel labels failed', error);
        throw unavailable('load the groups');
      }
      for (const c of (data ?? []) as Array<{
        id: string;
        label: string | null;
        waba_id: string | null;
      }>) {
        channelOf.set(c.id, {
          id: c.id,
          name: c.label || c.waba_id || 'WhatsApp number',
          phone: c.waba_id,
        });
      }
    }

    return NextResponse.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        icon_url: g.icon_url,
        participants_count: g.participants_count,
        our_role: g.our_role,
        channel_id: g.channel_id,
        channel: (g.channel_id && channelOf.get(g.channel_id)) || null,
        last_message_at: g.last_message_at,
        created_by: g.created_by,
        can_manage: canManage.has(g.id),
      })),
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function POST(request: Request) {
  const deadline = groupDeadline();
  try {
    const ctx = await getCurrentAccount();
    const body = parseCreate(await request.json().catch(() => null));

    const allowed = await ctx.supabase.rpc('whatsapp_group_can_create', {
      p_channel: body.channelId,
    });
    if (allowed.error) {
      console.error('[groups] can_create failed', allowed.error);
      throw unavailable('check access');
    }
    if (allowed.data !== true) {
      throw new GroupHttpError(
        403,
        'not_allowed',
        "You can't create a group on this number"
      );
    }

    // Contacts through the caller's RLS (one they cannot see is ignored
    // like an unknown id), and everyone screened against the consent
    // register as the participants route does: creating a group adds
    // people just as surely, so an opt-out has to hold here too.
    const screened = await screenRecipients(ctx, supabaseAdmin(), {
      contactIds: body.contactIds,
      phones: body.participants.waIds,
    });
    const contactIds = new Set(body.contactIds);
    const invalid = [
      ...body.participants.invalid,
      // A contact with no usable number is warned about in the wizard.
      ...screened.invalid.filter((x) => !contactIds.has(x)),
    ];
    // Typed numbers first, then contacts, as the wizard lists them.
    const waIds = [
      ...screened.recipients.filter((r) => !r.contactId),
      ...screened.recipients.filter((r) => r.contactId),
    ].map((r) => r.waId);
    if (waIds.length === 0) {
      throw new GroupHttpError(
        400,
        'no_participants',
        'None of the participants is a usable WhatsApp number'
      );
    }

    const managerIds = [...new Set([ctx.userId, ...body.managerIds])];
    if (body.managerIds.length > 0) {
      const { data, error } = await supabaseAdmin()
        .from('profiles')
        .select('user_id')
        .eq('account_id', ctx.accountId)
        .in('user_id', body.managerIds)
        .is('deactivated_at', null)
        .neq('account_role', 'bank_guest');
      if (error) {
        console.error('[groups] manager lookup failed', error);
        throw unavailable('check the managers');
      }
      const staff = new Set(
        ((data ?? []) as Array<{ user_id: string }>).map((p) => p.user_id)
      );
      if (body.managerIds.some((id) => !staff.has(id))) {
        throw new GroupHttpError(
          400,
          'invalid_manager',
          'Managers must be active staff of this workspace'
        );
      }
    }

    const channel = await loadWhapiChannel(ctx.accountId, body.channelId);
    const outcome = await createGroup({
      channel,
      name: body.name,
      participants: waIds,
      deadline,
    });

    const admin = supabaseAdmin();
    let group: WhatsappGroupRow;
    try {
      const snapshot = await createdSnapshot(channel, outcome, deadline);
      group = await persistGroupSnapshot(admin, channel, snapshot, {
        createdBy: ctx.userId,
      });
    } catch (err) {
      // The group exists on WhatsApp; a sync brings it in.
      console.error('[groups] created on WhatsApp but not saved', err);
      return NextResponse.json(
        {
          error:
            'The group was created on WhatsApp but could not be saved; run a sync',
          code: 'saved_failed_run_sync',
          wa_group_id: outcome.group.id,
        },
        { status: 502 }
      );
    }

    const warnings: string[] = [];
    if (outcome.error) warnings.push('adds_stopped');

    const mgr = await admin.from('whatsapp_group_managers').upsert(
      managerIds.map((user_id) => ({
        group_id: group.id,
        account_id: ctx.accountId,
        user_id,
      })),
      { onConflict: 'group_id,user_id', ignoreDuplicates: true }
    );
    if (mgr.error) {
      console.error('[groups] managers not saved', mgr.error);
      warnings.push('managers_not_saved');
    }

    const changes: Record<string, unknown> = {};
    if (body.description) {
      try {
        await updateGroupInfo({
          channel,
          groupId: group.wa_group_id,
          description: body.description,
        });
        changes.description = body.description;
      } catch (err) {
        console.error('[groups] description not set', err);
        warnings.push('description_not_set');
      }
    }
    const settings: GroupSettings = { ...group.settings };
    let settingFailed = false;
    for (const [setting, policy] of Object.entries(body.settings)) {
      try {
        await updateGroupSetting({
          channel,
          groupId: group.wa_group_id,
          setting: setting as GroupSetting,
          policy,
        });
        settings[setting as GroupSetting] = policy;
        changes.settings = settings;
      } catch (err) {
        console.error('[groups] setting not set', setting, err);
        settingFailed = true;
      }
    }
    if (settingFailed) warnings.push('settings_not_set');

    if (Object.keys(changes).length > 0) {
      const { data, error } = await admin
        .from('whatsapp_groups')
        .update(changes)
        .eq('id', group.id)
        .select(GROUP_COLUMNS)
        .single();
      // WhatsApp has it; the next refresh or sync records it.
      if (error) console.error('[groups] post-create update failed', error);
      else group = data as unknown as WhatsappGroupRow;
    }

    return NextResponse.json(
      {
        group,
        added: outcome.added,
        refused: outcome.refused,
        notAttempted: outcome.notAttempted,
        invalid: [...invalid, ...outcome.invalid],
        skipped: screened.skipped,
        warnings,
      },
      { status: 201 }
    );
  } catch (err) {
    return groupErrorResponse(err);
  }
}
