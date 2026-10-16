// ============================================================
// POST /api/meetings/[id]/join → `{ participantId, sessionId, iceServers }`
// (TURN + STUN when a Cloudflare TURN key is set, else STUN; lib/meetings/turn.ts).
// Access is `meeting_can_view` through the caller's client; only then
// does the service role write the participant row (no client policy).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { cutSeats } from '@/lib/meetings/cut';
import { isUuid } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  notConfiguredResponse,
  readErrorResponse,
  requireMeetingsUser,
  rpcFlag,
  sfuErrorResponse,
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';
import { createSession } from '@/lib/meetings/sfu';
import { meetingIceServers } from '@/lib/meetings/turn';

export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const unconfigured = notConfiguredResponse();
    if (unconfigured) return unconfigured;
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    // The caller reads their own removal (110's policy: user_id = auth.uid()).
    const [canView, loaded, removal] = await Promise.all([
      rpcFlag(supabase, 'meeting_can_view', id),
      loadMeeting(supabase, accountId, id),
      supabase
        .from('meeting_removed_users')
        .select('user_id')
        .eq('meeting_id', id)
        .eq('user_id', userId)
        .maybeSingle(),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canView.error) return readErrorResponse(canView.error);
    if (removal.error) return readErrorResponse(removal.error);
    // Removed by a manager: stays out until let back in, and no Cloudflare
    // session is made for them. Checked first: since 112 the removal also
    // hides the meeting from them, which would otherwise read as a 404.
    if (removal.data) return jsonError('removed_from_meeting', 403);
    const meeting = loaded.meeting;
    if (!canView.allowed || !meeting)
      return jsonError('Meeting not found', 404);
    if (meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }

    // TURN credentials are minted alongside the session; meetingIceServers
    // never throws (STUN only on any failure), so it cannot fail a join.
    const ice = meetingIceServers();
    let sessionId: string;
    try {
      sessionId = (await createSession()).sessionId;
    } catch (err) {
      const res = sfuErrorResponse(err);
      if (res) return res;
      throw err;
    }

    const admin = supabaseAdmin();
    // One open seat per person: a rejoin (another tab, a reload) closes
    // the old one. Close and insert are two writes, so two tabs at once
    // can race; 106's partial unique index refuses the second open seat
    // (23505) and the loser closes and inserts once more.
    const openSeat = async () => {
      const { error: closeErr } = await admin
        .from('meeting_participants')
        .update({ left_at: new Date().toISOString() })
        .eq('meeting_id', id)
        .eq('account_id', meeting.account_id)
        .eq('user_id', userId)
        .is('left_at', null);
      if (closeErr) return { data: null, error: closeErr };
      return admin
        .from('meeting_participants')
        .insert({
          meeting_id: id,
          account_id: meeting.account_id,
          user_id: userId,
          cf_session_id: sessionId,
        })
        .select('id')
        .single();
    };
    let { data, error } = await openSeat();
    if (error?.code === '23505') ({ data, error } = await openSeat());
    // Removed after the check above (110's trigger refuses the seat): the
    // same answer, and the session just made for them is cut.
    if (
      error?.code === 'P0001' &&
      error.message?.includes('removed_from_meeting')
    ) {
      await cutSeats([{ cf_session_id: sessionId }]);
      return jsonError('removed_from_meeting', 403);
    }
    if (error || !data) {
      return meetingDbErrorResponse(error ?? {}, 'Failed to join');
    }

    return NextResponse.json({
      participantId: data.id,
      sessionId,
      iceServers: await ice,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
