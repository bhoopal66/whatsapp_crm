// ============================================================
// POST /api/meetings/[id]/join → `{ participantId, sessionId, iceServers }`.
// Access is `meeting_can_view` through the caller's client; only then
// does the service role write the participant row (no client policy).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
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
import { MEETING_ICE_SERVERS } from '@/lib/meetings/types';

export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const unconfigured = notConfiguredResponse();
    if (unconfigured) return unconfigured;
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    const [canView, loaded] = await Promise.all([
      rpcFlag(supabase, 'meeting_can_view', id),
      loadMeeting(supabase, accountId, id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canView.error) return readErrorResponse(canView.error);
    const meeting = loaded.meeting;
    if (!canView.allowed || !meeting)
      return jsonError('Meeting not found', 404);
    if (meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }

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
    if (error || !data) {
      return meetingDbErrorResponse(error ?? {}, 'Failed to join');
    }

    return NextResponse.json({
      participantId: data.id,
      sessionId,
      iceServers: MEETING_ICE_SERVERS,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
