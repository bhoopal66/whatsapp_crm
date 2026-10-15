// ============================================================
// POST /api/meetings/[id]/end — end for everyone (host, owner, admin).
// Status 'ended' under the caller's RLS client; 106's guard trigger
// stamps ended_at and closes every open participant row. The open seats
// are read first (the trigger closes them), then their Cloudflare
// sessions are cut, so a client that ignores the 409 stops receiving.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { cutSeats } from '@/lib/meetings/cut';
import { isUuid } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  readErrorResponse,
  requireMeetingsUser,
  rpcFlag,
  type Params,
} from '@/lib/meetings/server';
import { MEETING_COLUMNS } from '@/lib/meetings/types';

export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    const [loaded, canManage] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      rpcFlag(supabase, 'meeting_can_manage', id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canManage.error) return readErrorResponse(canManage.error);
    if (!loaded.meeting) return jsonError('Meeting not found', 404);
    if (!canManage.allowed) {
      return jsonError('Only the host or an admin can end this meeting', 403);
    }
    if (loaded.meeting.status === 'ended') {
      return NextResponse.json({ meeting: loaded.meeting });
    }
    if (loaded.meeting.status !== 'scheduled') {
      return jsonError('This meeting was cancelled', 409);
    }
    // Before the update: entering 'ended' closes these rows. A failed
    // read changes nothing yet, so the host can simply retry.
    const seats = await supabase
      .from('meeting_participants')
      .select('cf_session_id')
      .eq('meeting_id', id)
      .is('left_at', null);
    if (seats.error) return readErrorResponse(seats.error);
    const { data, error } = await supabase
      .from('meetings')
      .update({ status: 'ended' })
      .eq('account_id', accountId)
      .eq('id', id)
      .eq('status', 'scheduled')
      .select(MEETING_COLUMNS)
      .maybeSingle();
    if (error) return meetingDbErrorResponse(error, 'Failed to end meeting');
    if (!data) return jsonError('This meeting has ended or was cancelled', 409);
    await cutSeats(seats.data ?? []);
    return NextResponse.json({ meeting: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
