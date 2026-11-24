// ============================================================
// /api/whatsapp/groups/[id]/participants — who is in a group (114).
// Our number must be a group admin. Adding is open to any staff member
// at agent level or above who can open the group (`groupAddBlock`,
// 2026-11-20); removing and promoting stay with its managers. POST adds
// people (skipping anyone who opted out or is do-not-contact, unless an
// owner/admin sends `overrideConsent: true`; at most 60 people an hour
// per person and 120 per number: the rest are `notAttempted` with
// `error: too_many_adds`, 429 when nobody is left to add), DELETE
// removes them, PATCH promotes or demotes. Our own number can be neither
// removed nor demoted: that would strand the group. After a change the
// snapshot is re-read, best effort.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { groupAddBlock } from '@/lib/groups/access';
import {
  namesOurNumber,
  requireConsentOverride,
  parseAddMembers,
  parseMemberList,
  parseRoleChange,
  requireActive,
  requireGroupAdmin,
} from '@/lib/groups/member-requests';
import { logConsentOverride, screenRecipients } from '@/lib/groups/recipients';
import { resyncGroup } from '@/lib/groups/resync';
import {
  channelForGroup,
  GroupHttpError,
  groupErrorResponse,
  loadGroupForCaller,
  supabaseAdmin,
} from '@/lib/groups/server';
import {
  addParticipants,
  demoteAdmins,
  groupDeadline,
  promoteAdmins,
  removeParticipants,
} from '@/lib/whatsapp/groups';
import {
  checkRateLimit,
  RATE_LIMITS,
  rateLimitRemaining,
} from '@/lib/rate-limit';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const ownNumber = () =>
  new GroupHttpError(
    400,
    'own_number',
    "A group's own number can't be removed or demoted here"
  );

export async function POST(request: Request, { params }: Params) {
  const deadline = groupDeadline();
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const input = parseAddMembers(await request.json().catch(() => null));
    // Visible through the caller's RLS is enough: no manager check.
    const group = await loadGroupForCaller(ctx, id);
    if (input.overrideConsent) requireConsentOverride(ctx.role);
    if (
      groupAddBlock({
        role: ctx.role,
        group: { channelId: group.channel_id, ourRole: group.our_role },
      }) === 'not_allowed'
    ) {
      throw new GroupHttpError(
        403,
        'not_allowed',
        "You can't add people to this group"
      );
    }
    requireActive(group);
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);

    const screened = await screenRecipients(ctx, supabaseAdmin(), input, {
      overrideConsent: input.overrideConsent,
    });
    // Mass-adding is what gets a number restricted: counted in people, for
    // the person adding and for the number.
    const waIds = screened.recipients.map((r) => r.waId);
    const budgets = [
      [`group-add:${ctx.userId}`, RATE_LIMITS.groupAddPerson],
      [`group-add-number:${channel.id}`, RATE_LIMITS.groupAddNumber],
    ] as const;
    const allowed = Math.min(
      waIds.length,
      ...budgets.map(([key, rule]) => rateLimitRemaining(key, rule))
    );
    if (allowed === 0 && waIds.length > 0) {
      throw new GroupHttpError(
        429,
        'too_many_adds',
        'Too many people were added in the last hour'
      );
    }
    for (let i = 0; i < allowed; i++) {
      for (const [key, rule] of budgets) checkRateLimit(key, rule);
    }
    const overLimit = waIds.slice(allowed);
    logConsentOverride(
      group.id,
      ctx.userId,
      screened.recipients.slice(0, allowed).filter((r) => r.overridden).length
    );
    const outcome =
      allowed > 0
        ? await addParticipants({
            channel,
            groupId: group.wa_group_id,
            participants: waIds.slice(0, allowed),
            deadline,
          })
        : null;
    const changed = (outcome?.added.length ?? 0) > 0;
    const resynced = changed
      ? await resyncGroup(channel, group.wa_group_id)
      : false;
    return NextResponse.json({
      added: outcome?.added ?? [],
      refused: outcome?.refused ?? [],
      notAttempted: [...(outcome?.notAttempted ?? []), ...overLimit],
      invalid: [
        ...screened.invalid,
        ...(outcome?.invalid ?? []),
        ...screened.notFound,
      ],
      skipped: screened.skipped,
      error: outcome?.error ?? (overLimit.length > 0 ? 'too_many_adds' : null),
      resynced,
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { waIds } = parseMemberList(await request.json().catch(() => null));
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireActive(group);
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);
    if (namesOurNumber(waIds, normalizePhone(channel.wabaId ?? '') || null)) {
      throw ownNumber();
    }
    const result = await removeParticipants({
      channel,
      groupId: group.wa_group_id,
      participants: waIds,
    });
    const resynced = await resyncGroup(channel, group.wa_group_id);
    return NextResponse.json({
      removed: result.processed,
      failed: result.failed,
      resynced,
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { waIds, role } = parseRoleChange(
      await request.json().catch(() => null)
    );
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireActive(group);
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);
    if (
      role === 'member' &&
      namesOurNumber(waIds, normalizePhone(channel.wabaId ?? '') || null)
    ) {
      throw ownNumber();
    }
    const change = role === 'admin' ? promoteAdmins : demoteAdmins;
    await change({ channel, groupId: group.wa_group_id, participants: waIds });
    const resynced = await resyncGroup(channel, group.wa_group_id);
    return NextResponse.json({ ok: true, waIds, role, resynced });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
