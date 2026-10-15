// ============================================================
// POST /api/meetings/[id]/heartbeat — `{ participantId, audioMuted,
// videoOff }` → last_seen_at = now(). Clients beat every 20 s; a row
// unheard for 60 s is no longer present. A meeting that ended or was
// cancelled closes the seat and answers 409, the client's cue to leave.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/meetings/requests';
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
    const body = (await readJson(request)) as {
      participantId?: unknown;
      audioMuted?: unknown;
      videoOff?: unknown;
    } | null;
    if (!isUuid(id) || !isUuid(body?.participantId)) {
      return jsonError('Invalid meeting or participant id', 400);
    }
    if (
      typeof body.audioMuted !== 'boolean' ||
      typeof body.videoOff !== 'boolean'
    ) {
      return jsonError('audioMuted and videoOff must be true or false', 400);
    }

    const [ownRead, loaded] = await Promise.all([
      loadOwnParticipant(ctx.supabase, ctx, id, body.participantId),
      loadMeeting(ctx.supabase, ctx.accountId, id),
    ]);
    // A failed read is not "you left": the client tears down on a 404.
    if (ownRead.error) return readErrorResponse(ownRead.error);
    if (loaded.error) return readErrorResponse(loaded.error);
    const own = ownRead.participant;
    if (!own || own.left_at || !loaded.meeting) {
      return jsonError('You are not in this meeting', 404);
    }
    const now = new Date().toISOString();
    const ended = loaded.meeting.status !== 'scheduled';
    const { error } = await supabaseAdmin()
      .from('meeting_participants')
      .update(
        ended
          ? { left_at: now }
          : {
              last_seen_at: now,
              audio_muted: body.audioMuted,
              video_off: body.videoOff,
            }
      )
      .eq('id', own.id)
      .is('left_at', null);
    if (error)
      return meetingDbErrorResponse(error, 'Failed to record heartbeat');
    if (ended) return jsonError('This meeting has ended or was cancelled', 409);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
