// ============================================================
// PUT /api/meetings/[id]/sfu/tracks/update — proxy Cloudflare
// tracks/update on the caller's own session: `{ participantId, request }`
// where every track is a pull (`location: 'remote'`) naming its `mid`
// and a `simulcast` layer (f, h, q). The engine uses it to switch a
// tile to the layer its size needs. An update can point a transceiver
// at another track, so the pull rule of tracks/new applies again: the
// session must belong to someone present in this meeting. Returns
// Cloudflare's JSON as is.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid, presenceCutoff } from '@/lib/meetings/requests';
import {
  jsonError,
  loadOwnParticipant,
  notConfiguredResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  sfuErrorResponse,
  type Params,
} from '@/lib/meetings/server';
import { updateTracks } from '@/lib/meetings/sfu';
import { checkTracksUpdate } from '@/lib/meetings/sfu-rules';

export async function PUT(request: Request, { params }: Params) {
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

    const [ownRead, present] = await Promise.all([
      loadOwnParticipant(ctx.supabase, ctx, id, body.participantId),
      ctx.supabase
        .from('meeting_participants')
        .select('cf_session_id')
        .eq('meeting_id', id)
        .is('left_at', null)
        .gt('last_seen_at', presenceCutoff(Date.now())),
    ]);
    if (ownRead.error) return readErrorResponse(ownRead.error);
    const own = ownRead.participant;
    if (!own || own.left_at) {
      return jsonError('You are not in this meeting', 404);
    }
    if (present.error) return readErrorResponse(present.error);

    const checked = checkTracksUpdate(
      body.request,
      new Set((present.data ?? []).map((p) => p.cf_session_id as string))
    );
    if (!checked.ok) return jsonError(checked.error, checked.status);

    try {
      return NextResponse.json(
        await updateTracks(own.cf_session_id, checked.value)
      );
    } catch (err) {
      const res = sfuErrorResponse(err);
      if (res) return res;
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
