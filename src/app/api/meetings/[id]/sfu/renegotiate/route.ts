// ============================================================
// PUT /api/meetings/[id]/sfu/renegotiate — proxy Cloudflare
// renegotiate on the caller's own session.
// Body `{ participantId, sessionDescription }`. A seat closed meanwhile
// answers 404 and its session is cut again.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/meetings/requests';
import {
  jsonError,
  loadOwnParticipant,
  notConfiguredResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  seatClosedMeanwhile,
  sfuErrorResponse,
  type Params,
} from '@/lib/meetings/server';
import { renegotiate } from '@/lib/meetings/sfu';
import { isSessionDescription } from '@/lib/meetings/sfu-rules';

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireMeetingsUser();
    const unconfigured = notConfiguredResponse();
    if (unconfigured) return unconfigured;
    const { id } = await params;
    const body = (await readJson(request)) as {
      participantId?: unknown;
      sessionDescription?: unknown;
    } | null;
    if (!isUuid(id) || !isUuid(body?.participantId)) {
      return jsonError('Invalid meeting or participant id', 400);
    }
    if (!isSessionDescription(body.sessionDescription)) {
      return jsonError('Invalid sessionDescription', 400);
    }
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
      answer = await renegotiate(own.cf_session_id, body.sessionDescription);
    } catch (err) {
      const res = sfuErrorResponse(err);
      if (res) return res;
      throw err;
    }
    if (await seatClosedMeanwhile(ctx.supabase, ctx, id, own))
      return jsonError('You are not in this meeting', 404);
    return NextResponse.json(answer);
  } catch (err) {
    return toErrorResponse(err);
  }
}
