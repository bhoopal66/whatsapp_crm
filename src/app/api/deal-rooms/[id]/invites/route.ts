import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendRoomInvites } from '@/lib/deal-rooms/invites';

/** One template send per invitee, each a gateway round trip. */
export const maxDuration = 60;

/**
 * Send the room's group invites to everyone listed who has not had one
 * yet: a re-send after the template was configured, or after a failed
 * send. `sendRoomInvites` claims each person before the send, so this
 * racing the `group_create` webhook invites nobody twice. Managers only
 * (`deal_room_can_manage`, asked as the caller); the sends run on the
 * service role.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const { data: canManage, error } = await ctx.supabase.rpc(
      'deal_room_can_manage',
      { p_room: id }
    );
    if (error) console.error('[deal-rooms] can_manage failed:', error.message);
    if (canManage !== true) {
      return NextResponse.json(
        { error: 'Only a manager of this deal room can send its invites' },
        { status: 403 }
      );
    }
    const summary = await sendRoomInvites(supabaseAdmin(), id);
    if (summary.notOpen) {
      return NextResponse.json(
        { error: 'The group is not created yet' },
        { status: 409 }
      );
    }
    if (summary.templateMissing) {
      return NextResponse.json(
        { error: 'Invite template not configured' },
        { status: 409 }
      );
    }
    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}
