// ============================================================
// /api/whatsapp/groups/[id]/participants — who is in a group (114).
// Managers only, and our number must be a group admin. POST adds people
// (skipping anyone who opted out or is do-not-contact), DELETE removes
// them, PATCH promotes or demotes. Our own number can be neither
// removed nor demoted: that would strand the group. After a change the
// snapshot is re-read, best effort.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  namesOurNumber,
  parseAddMembers,
  parseMemberList,
  parseRoleChange,
  requireActive,
  requireGroupAdmin,
} from '@/lib/groups/member-requests';
import { screenRecipients } from '@/lib/groups/recipients';
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
  promoteAdmins,
  removeParticipants,
} from '@/lib/whatsapp/groups';
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
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const input = parseAddMembers(await request.json().catch(() => null));
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireActive(group);
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);

    const screened = await screenRecipients(ctx, supabaseAdmin(), input);
    const outcome =
      screened.recipients.length > 0
        ? await addParticipants({
            channel,
            groupId: group.wa_group_id,
            participants: screened.recipients.map((r) => r.waId),
          })
        : null;
    const changed = (outcome?.added.length ?? 0) > 0;
    const resynced = changed
      ? await resyncGroup(channel, group.wa_group_id)
      : false;
    return NextResponse.json({
      added: outcome?.added ?? [],
      refused: outcome?.refused ?? [],
      notAttempted: outcome?.notAttempted ?? [],
      invalid: [
        ...screened.invalid,
        ...(outcome?.invalid ?? []),
        ...screened.notFound,
      ],
      skipped: screened.skipped,
      error: outcome?.error ?? null,
      resynced,
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
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
    const ctx = await getCurrentAccount();
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
