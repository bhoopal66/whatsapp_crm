// ============================================================
// /api/whatsapp/groups/[id]/requests — people asking to join (114).
// Managers only, and our number must be a group admin. GET lists the
// pending requests; POST approves or rejects one. An approval changes
// the roster, so the snapshot is re-read afterwards, best effort.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  parseJoinDecision,
  requireGroupAdmin,
} from '@/lib/groups/member-requests';
import { resyncGroup } from '@/lib/groups/resync';
import {
  channelForGroup,
  groupErrorResponse,
  loadGroupForCaller,
} from '@/lib/groups/server';
import {
  approveJoinRequest,
  listJoinRequests,
  rejectJoinRequest,
} from '@/lib/whatsapp/groups';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);
    const { requests } = await listJoinRequests({
      channel,
      groupId: group.wa_group_id,
    });
    return NextResponse.json({ requests });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { applicant, action } = parseJoinDecision(
      await request.json().catch(() => null)
    );
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);
    const decide =
      action === 'approve' ? approveJoinRequest : rejectJoinRequest;
    const result = await decide({
      channel,
      groupId: group.wa_group_id,
      applicant,
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error ?? 'WhatsApp did not accept the decision',
          code: 'request_failed',
        },
        { status: 422 }
      );
    }
    const resynced =
      action === 'approve'
        ? await resyncGroup(channel, group.wa_group_id)
        : false;
    return NextResponse.json({ ok: true, resynced });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
