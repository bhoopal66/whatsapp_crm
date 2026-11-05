// ============================================================
// POST /api/meetings/[id]/lock — `{ locked }` → `{ ok, locked_at }` (176).
// Host, owner or admin only (`meeting_can_manage`, caller's client); the
// service role then sets or clears locked_at / locked_by. Join refuses
// newcomers while it is set.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  migrationRequiredResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  rpcFlag,
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';

const CLOSED = 'This meeting has ended or was cancelled';

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const body = (await readJson(request)) as { locked?: unknown } | null;
    if (typeof body?.locked !== 'boolean') {
      return jsonError('locked must be true or false', 400);
    }

    const [loaded, canManage] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      rpcFlag(supabase, 'meeting_can_manage', id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canManage.error) return readErrorResponse(canManage.error);
    if (!loaded.meeting) return jsonError('Meeting not found', 404);
    if (!canManage.allowed) {
      return jsonError('Only the host or an admin can lock this meeting', 403);
    }
    if (loaded.meeting.status !== 'scheduled') return jsonError(CLOSED, 409);

    const lockedAt = body.locked ? new Date().toISOString() : null;
    const { data, error } = await supabaseAdmin()
      .from('meetings')
      .update({ locked_at: lockedAt, locked_by: body.locked ? userId : null })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle();
    if (error) {
      return (
        migrationRequiredResponse(error) ??
        meetingDbErrorResponse(error, 'Failed to lock the meeting')
      );
    }
    // Ended between the read and the write.
    if (!data) return jsonError(CLOSED, 409);
    return NextResponse.json({ ok: true, locked_at: lockedAt });
  } catch (err) {
    return toErrorResponse(err);
  }
}
