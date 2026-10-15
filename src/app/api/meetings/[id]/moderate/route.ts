// ============================================================
// POST /api/meetings/[id]/moderate — `{ target, action }` (107).
// Host, owner or admin only (`meeting_can_manage`, caller's client);
// the target must be an open seat of this meeting. Then, service role:
//   mute       → mute_requested_at = now (the client mutes itself)
//   lower_hand → hand_raised_at = null
//   remove     → left_at = removed_at = now, removed_by = caller, and
//                the seat's Cloudflare media is cut (`cutSeats`), so a
//                client that ignores it stops sending and receiving.
// Nobody removes themselves (that is Leave).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { cutSeats } from '@/lib/meetings/cut';
import { isUuid, parseModeration } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  rpcFlag,
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';
import { PARTICIPANT_COLUMNS, type ParticipantRow } from '@/lib/meetings/types';

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const parsed = parseModeration(await readJson(request));
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { target, action } = parsed.values;

    const [loaded, canManage, seat] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      rpcFlag(supabase, 'meeting_can_manage', id),
      supabase
        .from('meeting_participants')
        .select(PARTICIPANT_COLUMNS)
        .eq('id', target)
        .eq('meeting_id', id)
        .maybeSingle(),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canManage.error) return readErrorResponse(canManage.error);
    if (!loaded.meeting) return jsonError('Meeting not found', 404);
    if (!canManage.allowed) {
      return jsonError(
        'Only the host or an admin can moderate this meeting',
        403
      );
    }
    if (loaded.meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }
    if (seat.error) return readErrorResponse(seat.error);
    const row = seat.data as ParticipantRow | null;
    if (!row || row.left_at) {
      return jsonError('That person is not in this meeting', 404);
    }
    if (action === 'remove' && row.user_id === userId) {
      return jsonError(
        "You can't remove yourself; leave the meeting instead",
        400
      );
    }

    const now = new Date().toISOString();
    const update =
      action === 'mute'
        ? { mute_requested_at: now }
        : action === 'lower_hand'
          ? { hand_raised_at: null }
          : { left_at: now, removed_at: now, removed_by: userId };
    const { error } = await supabaseAdmin()
      .from('meeting_participants')
      .update(update)
      .eq('id', row.id)
      .eq('meeting_id', id)
      .is('left_at', null);
    if (error) return meetingDbErrorResponse(error, 'Failed to moderate');
    if (action === 'remove') await cutSeats([row]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
