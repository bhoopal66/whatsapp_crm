// ============================================================
// /api/whatsapp/groups/[id]/managers — who works a group (114).
// GET is open to anyone who can see the group. PUT replaces the whole
// set and is for owners/admins and the group's creator only; every id
// must be a live, non-guest member of the account (400
// `invalid_manager`). The creator's row is always kept, so a group is
// never left without the person who made it.
//
// Managers and their saved numbers are linked (2026-11-21): once the
// rows are written, a new manager's saved number (`staff_saved_phone`,
// migration 219) is added to the WhatsApp group and a dropped
// manager's is removed; someone with no saved number just sends from
// the app. This is best effort after the write and never fails it: the
// answer's `numbers` says what happened, including `refused` (WhatsApp
// wouldn't add them: share the invite link) and the group blocks
// (number_removed, left, not_group_admin). Our own number is never
// touched. The reverse direction is a trigger in 219.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canViewAllGroups } from '@/lib/auth/roles';
import {
  diffManagers,
  planManagerNumbers,
  type ManagerNumbersReport,
  type NumberBlock,
} from '@/lib/groups/manager-numbers';
import { parseManagerSet } from '@/lib/groups/member-requests';
import { resyncGroup } from '@/lib/groups/resync';
import {
  GroupHttpError,
  callerCanManage,
  channelForGroup,
  groupErrorResponse,
  loadGroupForCaller,
  supabaseAdmin,
} from '@/lib/groups/server';
import type { WhatsappGroupRow } from '@/lib/groups/types';
import {
  addParticipants,
  groupDeadline,
  removeParticipants,
} from '@/lib/whatsapp/groups';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

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

const identityDigits = (i: { jid: string; waId: string | null }) =>
  (i.waId ?? i.jid.split('@')[0] ?? '').replace(/\D/g, '');

/**
 * Bring the WhatsApp group in line with a manager change. Never throws:
 * the manager rows are already written, so every failure is reported.
 */
async function syncManagerNumbers(
  admin: Admin,
  group: WhatsappGroupRow,
  added: string[],
  removed: string[],
  deadline: number
): Promise<ManagerNumbersReport> {
  const report: ManagerNumbersReport = { added: [], removed: [], failed: [] };
  const people = [...added, ...removed];
  if (people.length === 0) return report;
  try {
    const names = new Map<string, string>();
    const { data: rows } = await admin
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', group.account_id)
      .in('user_id', people);
    for (const p of (rows ?? []) as {
      user_id: string;
      full_name: string | null;
    }[]) {
      if (p.full_name) names.set(p.user_id, p.full_name);
    }
    const phones = new Map<string, string | null>();
    for (const userId of people) {
      const { data, error } = await admin.rpc('staff_saved_phone', {
        p_account: group.account_id,
        p_user: userId,
      });
      if (error) {
        console.error('[groups] saved number lookup failed', error);
        report.failed.push({
          name: names.get(userId) ?? '',
          reason: 'unavailable',
        });
        continue;
      }
      phones.set(userId, typeof data === 'string' && data ? data : null);
    }
    const lookedUp = (ids: string[]) => ids.filter((u) => phones.has(u));
    const block: NumberBlock | null =
      group.channel_id === null
        ? 'number_removed'
        : group.our_role === 'left'
          ? 'left'
          : group.our_role !== 'admin'
            ? 'not_group_admin'
            : null;
    const { data: parts, error: partsError } = await admin
      .from('whatsapp_group_participants')
      .select('wa_id')
      .eq('account_id', group.account_id)
      .eq('group_id', group.id);
    if (partsError) throw partsError;
    const participants = ((parts ?? []) as { wa_id: string }[]).map(
      (p) => p.wa_id
    );
    const draft = {
      added: lookedUp(added),
      removed: lookedUp(removed),
      phones,
      names,
      participants,
      block,
    };
    // The channel is loaded only when there is something to do on it.
    const first = planManagerNumbers({ ...draft, ourNumber: null });
    for (const s of first.skipped) report.failed.push(s);
    if (first.add.length === 0 && first.remove.length === 0) return report;

    let channel;
    try {
      channel = await channelForGroup(group);
    } catch (err) {
      console.error('[groups] manager numbers: channel load failed', err);
      const reason = err instanceof GroupHttpError ? err.code : 'unavailable';
      for (const c of [...first.add, ...first.remove]) {
        report.failed.push({ name: c.name, reason });
      }
      return report;
    }
    const plan = planManagerNumbers({
      ...draft,
      ourNumber: normalizePhone(channel.wabaId ?? '') || null,
    });

    let changed = false;
    if (plan.add.length > 0) {
      try {
        const outcome = await addParticipants({
          channel,
          groupId: group.wa_group_id,
          participants: plan.add.map((c) => c.waId),
          deadline,
        });
        const ok = new Set(outcome.added.map(identityDigits));
        const refused = new Set(outcome.refused.map(identityDigits));
        for (const c of plan.add) {
          if (ok.has(c.waId)) {
            report.added.push(c.name);
            changed = true;
          } else if (refused.has(c.waId)) {
            report.failed.push({ name: c.name, reason: 'refused' });
          } else {
            report.failed.push({
              name: c.name,
              reason: outcome.error ?? 'unknown',
            });
          }
        }
      } catch (err) {
        console.error('[groups] manager number add failed', err);
        for (const c of plan.add) {
          report.failed.push({ name: c.name, reason: 'unavailable' });
        }
      }
    }
    if (plan.remove.length > 0) {
      try {
        const result = await removeParticipants({
          channel,
          groupId: group.wa_group_id,
          participants: plan.remove.map((c) => c.waId),
        });
        const ok = new Set(result.processed.map(identityDigits));
        for (const c of plan.remove) {
          if (ok.has(c.waId)) {
            report.removed.push(c.name);
            changed = true;
          } else {
            report.failed.push({ name: c.name, reason: 'unknown' });
          }
        }
      } catch (err) {
        console.error('[groups] manager number removal failed', err);
        for (const c of plan.remove) {
          report.failed.push({ name: c.name, reason: 'unavailable' });
        }
      }
    }
    if (changed) await resyncGroup(channel, group.wa_group_id);
    return report;
  } catch (err) {
    console.error('[groups] manager numbers failed', err);
    return {
      ...report,
      failed: [...report.failed, { name: '', reason: 'unavailable' }],
    };
  }
}

export async function PUT(request: Request, { params }: Params) {
  const deadline = groupDeadline();
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
    const before = ((current ?? []) as { user_id: string }[]).map(
      (r) => r.user_id
    );
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
      deadline
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
