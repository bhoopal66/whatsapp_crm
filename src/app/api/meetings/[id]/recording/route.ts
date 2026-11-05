// ============================================================
// POST /api/meetings/[id]/recording — `{ recording }` →
// `{ ok, recording_started_at, recording_by }` (176).
// Starting is for the host, an owner or an admin (`meeting_can_manage`,
// caller's client); stopping also for the person recording, who may have
// lost that since. One recording at a time: starting over someone else's
// answers 409 `already_recording`, and starting your own again changes
// nothing. The service role writes.
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
    const body = (await readJson(request)) as { recording?: unknown } | null;
    if (typeof body?.recording !== 'boolean') {
      return jsonError('recording must be true or false', 400);
    }
    const { recording } = body;

    const [loaded, canManage] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      rpcFlag(supabase, 'meeting_can_manage', id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canManage.error) return readErrorResponse(canManage.error);
    const meeting = loaded.meeting;
    if (!meeting) return jsonError('Meeting not found', 404);
    const stoppingOwn = !recording && meeting.recording_by === userId;
    if (!canManage.allowed && !stoppingOwn) {
      return jsonError(
        'Only the host or an admin can record this meeting',
        403
      );
    }
    if (meeting.status !== 'scheduled') return jsonError(CLOSED, 409);
    if (recording && meeting.recording_started_at) {
      if (meeting.recording_by !== userId) {
        return jsonError('already_recording', 409);
      }
      return NextResponse.json({
        ok: true,
        recording_started_at: meeting.recording_started_at,
        recording_by: userId,
      });
    }

    const values = recording
      ? { recording_started_at: new Date().toISOString(), recording_by: userId }
      : { recording_started_at: null, recording_by: null };
    const write = supabaseAdmin()
      .from('meetings')
      .update(values)
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'scheduled');
    // Compare-and-set on a start: of two racing managers, one wins. Someone
    // stopping their own, without manage rights, clears only their own:
    // a newer recording by someone else must keep its indicator.
    const { data, error } = await (
      recording
        ? write.is('recording_started_at', null)
        : canManage.allowed
          ? write
          : write.eq('recording_by', userId)
    )
      .select('id')
      .maybeSingle();
    if (error) {
      return (
        migrationRequiredResponse(error) ??
        meetingDbErrorResponse(error, 'Failed to change the recording')
      );
    }
    if (!data) {
      return jsonError(recording ? 'already_recording' : CLOSED, 409);
    }
    return NextResponse.json({ ok: true, ...values });
  } catch (err) {
    return toErrorResponse(err);
  }
}
