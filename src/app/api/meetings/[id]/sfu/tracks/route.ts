// ============================================================
// POST /api/meetings/[id]/sfu/tracks — proxy Cloudflare tracks/new
// on the caller's own session. Body `{ participantId, request }`.
//
// The caller's open participant row is found through their RLS client;
// `checkTracksRequest` confines local names to `${participantId}:` and
// remote tracks to sessions of people present in this meeting. Accepted
// local tracks are recorded on the row (service role) so others can
// discover them. Returns Cloudflare's JSON as is.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid, presenceCutoff } from '@/lib/meetings/requests';
import {
  jsonError,
  loadOwnParticipant,
  meetingDbErrorResponse,
  notConfiguredResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  sfuErrorResponse,
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';
import { newTracks } from '@/lib/meetings/sfu';
import {
  acceptedLocalTracks,
  checkTracksRequest,
  withTracks,
} from '@/lib/meetings/sfu-rules';

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireMeetingsUser();
    const unconfigured = notConfiguredResponse();
    if (unconfigured) return unconfigured;
    const { id } = await params;
    const body = (await readJson(request)) as {
      participantId?: unknown;
      request?: unknown;
    } | null;
    if (!isUuid(id) || !isUuid(body?.participantId)) {
      return jsonError('Invalid meeting or participant id', 400);
    }
    const participantId = body.participantId;

    const [ownRead, present] = await Promise.all([
      loadOwnParticipant(ctx.supabase, ctx, id, participantId),
      ctx.supabase
        .from('meeting_participants')
        .select('cf_session_id')
        .eq('meeting_id', id)
        .is('left_at', null)
        .gt('last_seen_at', presenceCutoff(Date.now())),
    ]);
    if (ownRead.error) return readErrorResponse(ownRead.error);
    const own = ownRead.participant;
    if (!own || own.left_at)
      return jsonError('You are not in this meeting', 404);
    if (present.error) {
      return meetingDbErrorResponse(
        present.error,
        'Failed to load participants'
      );
    }

    const checked = checkTracksRequest(
      body.request,
      participantId,
      new Set((present.data ?? []).map((p) => p.cf_session_id as string))
    );
    if (!checked.ok) return jsonError(checked.error, checked.status);

    let answer;
    try {
      answer = await newTracks(own.cf_session_id, checked.value.request);
    } catch (err) {
      const res = sfuErrorResponse(err);
      if (res) return res;
      throw err;
    }

    const added = acceptedLocalTracks(checked.value.localTracks, answer);
    if (added.length > 0) {
      // Read-modify-write: the client serialises its negotiation, so one
      // participant never has two of these in flight.
      const { error } = await supabaseAdmin()
        .from('meeting_participants')
        .update({ tracks: withTracks(own.tracks ?? [], added) })
        .eq('id', own.id)
        .is('left_at', null);
      if (error)
        return meetingDbErrorResponse(error, 'Failed to record tracks');
    }
    return NextResponse.json(answer);
  } catch (err) {
    return toErrorResponse(err);
  }
}
