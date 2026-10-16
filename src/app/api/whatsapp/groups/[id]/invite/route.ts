// ============================================================
// /api/whatsapp/groups/[id]/invite — a group's invite link (114).
// Managers only, and our number must be a group admin (WhatsApp shows
// the link to admins only). GET serves the cached link while it is
// under an hour old, else asks Whapi and caches it. POST `reset`
// revokes it and caches the new one; POST `send` sends it 1:1 from the
// group's number, paced, skipping anyone who opted out or is marked
// do-not-contact.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  INVITE_STOP_ON,
  isFreshInvite,
  parseInviteAction,
  planInviteSends,
  requireGroupAdmin,
} from '@/lib/groups/member-requests';
import { screenRecipients } from '@/lib/groups/recipients';
import {
  channelForGroup,
  groupErrorResponse,
  loadGroupForCaller,
  supabaseAdmin,
} from '@/lib/groups/server';
import type { WhatsappGroupRow } from '@/lib/groups/types';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  describeGroupFailure,
  GROUP_ADD_POLICY,
  getInviteLink,
  groupDeadline,
  resetInviteLink,
  sendInviteLink,
  withinBudget,
} from '@/lib/whatsapp/groups';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };
type Invite = { code: string; link: string };

async function cacheInvite(group: WhatsappGroupRow, invite: Invite) {
  const { error } = await supabaseAdmin().from('whatsapp_group_invites').upsert(
    {
      group_id: group.id,
      account_id: group.account_id,
      invite_code: invite.code,
      invite_link: invite.link,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: 'group_id' }
  );
  // The link is valid whether or not the cache write lands.
  if (error) console.error('[groups] invite cache write failed', error);
}

async function currentInvite(
  ctx: Awaited<ReturnType<typeof getCurrentAccount>>,
  group: WhatsappGroupRow,
  channel: () => Promise<WhatsAppChannel>
): Promise<Invite> {
  const { data } = await ctx.supabase
    .from('whatsapp_group_invites')
    .select('invite_code, invite_link, fetched_at')
    .eq('group_id', group.id)
    .maybeSingle();
  const row = data as {
    invite_code: string;
    invite_link: string;
    fetched_at: string;
  } | null;
  if (row && isFreshInvite(row.fetched_at)) {
    return { code: row.invite_code, link: row.invite_link };
  }
  const invite = await getInviteLink({
    channel: await channel(),
    groupId: group.wa_group_id,
  });
  await cacheInvite(group, invite);
  return invite;
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireGroupAdmin(group);
    const invite = await currentInvite(ctx, group, () =>
      channelForGroup(group)
    );
    return NextResponse.json(invite);
  } catch (err) {
    return groupErrorResponse(err);
  }
}

type SendResult = {
  waId: string;
  contactId: string | null;
  status: 'sent' | 'failed' | 'skipped' | 'not_attempted' | 'invalid';
  reason: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request, { params }: Params) {
  const budget = { deadline: groupDeadline() };
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const action = parseInviteAction(await request.json().catch(() => null));
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);

    if (action.action === 'reset') {
      const invite = await resetInviteLink({
        channel,
        groupId: group.wa_group_id,
      });
      await cacheInvite(group, invite);
      return NextResponse.json(invite);
    }

    const screened = await screenRecipients(ctx, supabaseAdmin(), action);
    const results: SendResult[] = [
      ...screened.skipped.map((s) => ({
        ...s,
        status: 'skipped' as const,
      })),
      ...screened.invalid.map((input) => ({
        waId: input,
        contactId: null,
        status: 'invalid' as const,
        reason: 'invalid',
      })),
      ...screened.notFound.map((contactId) => ({
        waId: '',
        contactId,
        status: 'invalid' as const,
        reason: 'not_found',
      })),
    ];
    const contactOf = new Map(
      screened.recipients.map((r) => [r.waId, r.contactId])
    );
    const plan = planInviteSends(screened.recipients.map((r) => r.waId));
    const invite =
      plan.batches.length > 0
        ? await currentInvite(ctx, group, async () => channel)
        : null;
    const body = action.message
      ? action.message.includes('%URL%')
        ? action.message
        : `${action.message}\n%URL%`
      : undefined;

    let stopped: string | null = null;
    for (let i = 0; i < plan.batches.length; i++) {
      if (i > 0 && !stopped) {
        // Past maxDuration the function is killed mid-loop and nobody
        // learns who got the link; stop in time and report the rest.
        if (withinBudget(budget, GROUP_ADD_POLICY.pauseMs)) {
          await sleep(GROUP_ADD_POLICY.pauseMs);
        } else stopped = 'time_budget';
      }
      for (const waId of plan.batches[i]) {
        const base = { waId, contactId: contactOf.get(waId) ?? null };
        if (!stopped && !withinBudget(budget)) stopped = 'time_budget';
        if (stopped) {
          results.push({ ...base, status: 'not_attempted', reason: stopped });
          continue;
        }
        try {
          await sendInviteLink({
            channel,
            inviteCode: invite!.code,
            to: waId,
            body,
            ...budget,
          });
          results.push({ ...base, status: 'sent', reason: null });
        } catch (err) {
          const key = describeGroupFailure(err);
          results.push({ ...base, status: 'failed', reason: key });
          if (INVITE_STOP_ON.includes(key)) stopped = key;
        }
      }
    }
    for (const waId of plan.overflow) {
      results.push({
        waId,
        contactId: contactOf.get(waId) ?? null,
        status: 'not_attempted',
        reason: 'over_limit',
      });
    }
    const count = (s: SendResult['status']) =>
      results.filter((r) => r.status === s).length;
    return NextResponse.json({
      link: invite?.link ?? null,
      sent: count('sent'),
      failed: count('failed'),
      skipped: count('skipped'),
      results,
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
