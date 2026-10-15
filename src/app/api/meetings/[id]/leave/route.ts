// ============================================================
// POST /api/meetings/[id]/leave — `{ participantId }` → left_at = now().
// Idempotent: leaving a seat already closed answers ok.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/meetings/requests';
import {
  jsonError,
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
    if (own.left_at) return NextResponse.json({ ok: true });

    const { error } = await supabaseAdmin()
      .from('meeting_participants')
      .update({ left_at: new Date().toISOString() })
      .eq('id', own.id)
      .is('left_at', null);
    if (error) return meetingDbErrorResponse(error, 'Failed to leave');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
