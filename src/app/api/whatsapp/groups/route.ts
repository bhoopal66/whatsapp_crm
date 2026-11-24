// ============================================================
// /api/whatsapp/groups — the group list and group creation
// (migration 114).
// GET: the groups the caller's RLS shows, latest activity first, each
// with its number's display name and whether the caller manages it,
// merged with the caller's ACTIVE submission groups (kind 'submission',
// `merge-list.ts`). Mirror rows of submission groups are left out.
// POST: create a group on a Whapi number the caller may use
// (`whatsapp_group_can_create`). WhatsApp first; the service role then
// persists what WhatsApp made, and description, settings and managers
// follow best-effort, reported as `warnings`. A create whose answer was
// lost is `create_unconfirmed`, and the same name again within minutes
// is `create_repeat` unless `createAnother` (`create-outcome.ts`).
// ============================================================

import { after, NextResponse } from 'next/server';

import {
  getCurrentAccount,
  type AccountContext,
  assertSalesAccess,
} from '@/lib/auth/account';
import { canSendMessages } from '@/lib/auth/roles';
import {
  addBudget,
  refundGroupCreate,
  spendGroupCreate,
} from '@/lib/groups/add-budget';
import {
  claimUnconfirmedGroup,
  CREATE_REPEAT_RULE,
  createRepeat,
  createRepeatKey,
  createUnconfirmed,
  isDefiniteCreateRefusal,
  saveGroupManagers,
} from '@/lib/groups/create-outcome';
import {
  mergeGroupList,
  SUBMISSION_ROW_COLUMNS,
  type SubmissionListRow,
} from '@/lib/groups/merge-list';
import { syncManagerNumbers } from '@/lib/groups/manager-sync';
import { screenRecipients } from '@/lib/groups/recipients';
import { nameSearchPattern, parseCreate } from '@/lib/groups/requests';
import {
  accountSubmissionWaIds,
  GROUP_COLUMNS,
  GroupHttpError,
  groupErrorResponse,
  loadGroupChannel,
  persistGroupSnapshot,
  supabaseAdmin,
} from '@/lib/groups/server';
import type {
  GroupSetting,
  GroupSettings,
  WhatsappGroupRow,
} from '@/lib/groups/types';
import {
  checkRateLimit,
  rateLimitRemaining,
  refundRateLimit,
} from '@/lib/rate-limit';
import { loadUnread } from '@/lib/submission-groups/view-refs';
import { searchTerm, sortColumn } from '@/lib/submission-groups/views';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  createGroup,
  type CreateGroupOutcome,
  getGroup,
  GROUP_ADD_POLICY,
  GroupCreateUnsupportedError,
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

/**
 * The caller's listable submission groups, through their own RLS client:
 * this read decides who sees which group, so it never runs on the service
 * role. The account pin matters: the read rule is not limited to the
 * active workspace. Only a group that exists on WhatsApp and is ACTIVE
 * (an ENDED group's reads are audited, on the Submission groups page).
 * Agents and up, as the page behind the row. A failed read is an empty
 * list: the rest of the page must still answer.
 */
async function listedSubmissionRows(
  ctx: AccountContext,
  q: string | null
): Promise<SubmissionListRow[]> {
  const searching = nameSearchPattern(q) !== null;
  // `searchTerm`, not the name pattern: this one goes inside `or()`.
  const term = searching ? searchTerm(q) : null;
  if (!canSendMessages(ctx.role) || (searching && !term)) return [];
  let query = ctx.supabase
    .from('submission_groups')
    .select(SUBMISSION_ROW_COLUMNS)
    .eq('account_id', ctx.accountId)
    .eq('status', 'ACTIVE')
    .eq('wa_mode', 'group')
    .not('wa_group_id', 'is', null);
  if (term) {
    query = query.or(`subject.ilike.*${term}*,customer_name.ilike.*${term}*`);
  }
  const { data, error } = await query
    .order(sortColumn('ACTIVE'), { ascending: false })
    .order('id', { ascending: false })
    .limit(LIST_LIMIT);
  if (error) {
    console.error('[groups] submission groups failed', error);
    return [];
  }
  return (data ?? []) as unknown as SubmissionListRow[];
}

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const q = new URL(request.url).searchParams.get('q');
    const pattern = nameSearchPattern(q);
    let query = ctx.supabase
      .from('whatsapp_groups')
      .select(GROUP_COLUMNS)
      .eq('account_id', ctx.accountId);
    if (pattern) query = query.ilike('name', pattern);
    const [list, manageable, submissionRows, unread, mirrorWaIds] =
      await Promise.all([
        query
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .order('name', { ascending: true })
          .limit(LIST_LIMIT),
        ctx.supabase.rpc('whatsapp_group_manageable_ids'),
        listedSubmissionRows(ctx, q),
        loadUnread(ctx.supabase),
        accountSubmissionWaIds(supabaseAdmin(), ctx.accountId).catch((err) => {
          console.error('[groups] submission group ids failed', err);
          return new Set<string>();
        }),
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
      ...new Set(
        [...groups, ...submissionRows].map((g) => g.channel_id).filter(Boolean)
      ),
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
      groups: mergeGroupList({
        groups,
        submissionRows,
        mirrorWaIds,
        unread,
        canManage,
        channelOf,
      }),
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function POST(request: Request) {
  const deadline = groupDeadline();
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
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

    const channel = await loadGroupChannel(ctx.accountId, body.channelId);
    // Creating adds people just as surely (add-budget.ts). With room for
    // only some, the rest are reported as not attempted.
    const budget = addBudget(ctx.userId, channel.id);
    if (budget.remaining() === 0) throw budget.refusal();
    // Peeked before the caps are spent and taken right after (no await in
    // between), so a repeat costs nothing and a refused cap takes no name.
    const sameName = createRepeatKey(ctx.userId, channel.id, body.name);
    if (
      !body.createAnother &&
      rateLimitRemaining(sameName, CREATE_REPEAT_RULE) === 0
    ) {
      throw createRepeat();
    }
    spendGroupCreate(channel.id);
    const tookName = checkRateLimit(sameName, CREATE_REPEAT_RULE).success;
    const most = Math.min(waIds.length, GROUP_ADD_POLICY.maxPerOperation);
    const room = budget.spend(most);
    const asked = room < most ? waIds.slice(0, room) : waIds;
    const overLimit = waIds.slice(asked.length);
    const startedAt = Date.now();
    let outcome: CreateGroupOutcome;
    try {
      outcome = await createGroup({
        channel,
        name: body.name,
        participants: asked,
        deadline,
      });
    } catch (err) {
      // This gateway cannot create: the next try is on another number.
      if (err instanceof GroupCreateUnsupportedError) {
        budget.refund(room);
        refundGroupCreate(channel.id);
      }
      if (isDefiniteCreateRefusal(err)) {
        if (tookName) refundRateLimit(sameName, 1);
        throw err;
      }
      console.error('[groups] create outcome unknown', err);
      after(() =>
        claimUnconfirmedGroup(supabaseAdmin(), {
          channel,
          name: body.name,
          startedAt,
          createdBy: ctx.userId,
          managerIds,
        })
      );
      throw createUnconfirmed();
    }

    const admin = supabaseAdmin();
    let group: WhatsappGroupRow;
    try {
      const snapshot = await createdSnapshot(channel, outcome, deadline);
      const saved = await persistGroupSnapshot(admin, channel, snapshot, {
        createdBy: ctx.userId,
      });
      if (!saved) throw new Error('new group id has a tombstone');
      group = saved;
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

    const mgrError = await saveGroupManagers(
      admin,
      ctx.accountId,
      group.id,
      managerIds
    );
    if (mgrError) {
      console.error('[groups] managers not saved', mgrError);
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

    // The chosen managers' saved numbers, as the managers PUT does it. Last:
    // on little time left this is what may be cut short, and it says so.
    const numbers = mgrError
      ? null
      : await syncManagerNumbers(
          admin,
          group,
          managerIds.filter((id) => id !== ctx.userId),
          [],
          deadline,
          ctx.userId
        );

    return NextResponse.json(
      {
        group,
        numbers,
        added: outcome.added,
        refused: outcome.refused,
        notAttempted: [...outcome.notAttempted, ...overLimit],
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
