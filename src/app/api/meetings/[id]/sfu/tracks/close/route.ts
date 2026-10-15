// ============================================================
// PUT /api/meetings/[id]/sfu/tracks/close — proxy Cloudflare
// tracks/close on the caller's own session, then drop the closed local
// names from the participant row. Body `{ participantId, request,
// closedLocalTrackNames? }`.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/meetings/requests';
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
import { closeTracks } from '@/lib/meetings/sfu';
import { checkCloseTracks, withoutTracks } from '@/lib/meetings/sfu-rules';

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireMeetingsUser();
    const unconfigured = notConfiguredResponse();
    if (unconfigured) return unconfigured;
    const { id } = await params;
    const body = (await readJson(request)) as {
      participantId?: unknown;
      request?: unknown;
      closedLocalTrackNames?: unknown;
    } | null;
    if (!isUuid(id) || !isUuid(body?.participantId)) {
      return jsonError('Invalid meeting or participant id', 400);
    }
    const checked = checkCloseTracks(
      body.request,
      body.closedLocalTrackNames,
      body.participantId
    );
    if (!checked.ok) return jsonError(checked.error, checked.status);

    const ownRead = await loadOwnParticipant(
      ctx.supabase,
      ctx,
      id,
      body.participantId
    );
    if (ownRead.error) return readErrorResponse(ownRead.error);
    const own = ownRead.participant;
    if (!own || own.left_at)
      return jsonError('You are not in this meeting', 404);

    let answer;
    try {
      answer = await closeTracks(own.cf_session_id, checked.value.request);
    } catch (err) {
      const res = sfuErrorResponse(err);
      if (res) return res;
      throw err;
    }

    if (checked.value.closedNames.length > 0) {
      const { error } = await supabaseAdmin()
        .from('meeting_participants')
        .update({
          tracks: withoutTracks(own.tracks ?? [], checked.value.closedNames),
        })
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
