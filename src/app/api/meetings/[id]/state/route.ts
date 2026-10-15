// ============================================================
// POST /api/meetings/[id]/state — `{ participantId, handRaised?,
// audioMuted?, videoOff? }` on the caller's own open seat (107).
//
// Raising a hand stamps hand_raised_at once (raising it again keeps the
// place in the queue); lowering clears it. The mute/camera flags let a
// toggle show at once instead of at the next 20 s heartbeat. Found
// through the caller's RLS client; written by the service role, as the
// heartbeat is (participants have no client write policy).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid, parseSeatState } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  loadOwnParticipant,
  meetingDbErrorResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const parsed = parseSeatState(await readJson(request));
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { participantId, handRaised, audioMuted, videoOff } = parsed.values;

    const [ownRead, loaded] = await Promise.all([
      loadOwnParticipant(ctx.supabase, ctx, id, participantId),
      loadMeeting(ctx.supabase, ctx.accountId, id),
    ]);
    if (ownRead.error) return readErrorResponse(ownRead.error);
    if (loaded.error) return readErrorResponse(loaded.error);
    const own = ownRead.participant;
    if (!own || own.left_at || !loaded.meeting) {
      return jsonError('You are not in this meeting', 404);
    }
    if (loaded.meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }

    const now = new Date().toISOString();
    const hand_raised_at =
      handRaised === undefined
        ? own.hand_raised_at
        : handRaised
          ? (own.hand_raised_at ?? now)
          : null;
    const update: Record<string, unknown> = { last_seen_at: now };
    if (handRaised !== undefined) update.hand_raised_at = hand_raised_at;
    if (audioMuted !== undefined) update.audio_muted = audioMuted;
    if (videoOff !== undefined) update.video_off = videoOff;
    const { error } = await supabaseAdmin()
      .from('meeting_participants')
      .update(update)
      .eq('id', own.id)
      .is('left_at', null);
    if (error) return meetingDbErrorResponse(error, 'Failed to update state');
    return NextResponse.json({ ok: true, hand_raised_at });
  } catch (err) {
    return toErrorResponse(err);
  }
}
