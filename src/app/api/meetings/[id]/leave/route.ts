// ============================================================
// POST /api/meetings/[id]/leave — `{ participantId }` → left_at = now().
// Idempotent: leaving a seat already closed answers ok. Either way the
// seat's Cloudflare session is cut, so its media stops at the SFU too.
// Closing the seat of the person recording also clears the recording.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { cutSeats } from '@/lib/meetings/cut';
import { isUuid } from '@/lib/meetings/requests';
import {
  isMissingColumn,
  jsonError,
  loadOwnParticipant,
  meetingDbErrorResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';

/**
 * Best effort, and it must never fail the leave. One filtered write, so
 * nobody else's recording is touched; a database without 176 refuses it
 * on every leave, which is not worth a log line.
 */
async function stopOwnRecording(meetingId: string, userId: string) {
  try {
    const { error } = await supabaseAdmin()
      .from('meetings')
      .update({ recording_started_at: null, recording_by: null })
      .eq('id', meetingId)
      .eq('recording_by', userId);
    if (error && !isMissingColumn(error)) {
      console.error('[meetings] clearing the recording failed', error);
    }
  } catch (err) {
    console.error('[meetings] clearing the recording failed', err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireMeetingsUser();
    const { id } = await params;
    const body = (await readJson(request)) as {
      participantId?: unknown;
    } | null;
    if (!isUuid(id) || !isUuid(body?.participantId)) {
      return jsonError('Invalid meeting or participant id', 400);
    }
    const ownRead = await loadOwnParticipant(
      ctx.supabase,
      ctx,
      id,
      body.participantId
    );
    if (ownRead.error) return readErrorResponse(ownRead.error);
    const own = ownRead.participant;
    if (!own) return jsonError('You are not in this meeting', 404);
    if (!own.left_at) {
      const { error } = await supabaseAdmin()
        .from('meeting_participants')
        .update({ left_at: new Date().toISOString() })
        .eq('id', own.id)
        .is('left_at', null);
      if (error) return meetingDbErrorResponse(error, 'Failed to leave');
      // Only when this call closed the seat: a seat already closed may be
      // a stale tab of someone recording from their new seat.
      await stopOwnRecording(id, ctx.userId);
    }
    await cutSeats([own]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
