// ============================================================
// POST /api/meetings/[id]/recording — `{ recording, force? }` →
// `{ ok, recording_started_at, recording_by }` (176).
// Starting is for the host, an owner or an admin (`meeting_can_manage`,
// caller's client); stopping also for the person recording, who may have
// lost that since. One recording at a time: starting over someone else's
// answers 409 `already_recording`, unless they have gone from the call.
// Starting over your own old flag is a new recording too: only a browser
// that lost its recorder can ask, and everyone must hear of it again.
// `{ recording: false }` stops the caller's own recording and
// nobody else's: a save can finish long after the flag was cleared and
// another manager started, so a late stop must find nothing to clear.
// That answers ok with the row as it stands. `force` is a manager
// clearing someone else's flag, a crashed recorder's. The service role
// writes.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid, presenceCutoff } from '@/lib/meetings/requests';
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

/**
 * Is the person a recording flag names still in the call? A crashed
 * browser cannot clear its flag, and its recording died with it. The
 * same presence rule as everywhere: gone means not left and not seen
 * inside the window, which is shorter than the room's 90 s grace, so
 * Record is never offered back before this agrees it may be taken.
 */
async function recorderInCall(
  supabase: Awaited<ReturnType<typeof requireMeetingsUser>>['supabase'],
  meetingId: string,
  recorder: string | null | undefined
) {
  if (!recorder) return { present: false, error: null };
  const { data, error } = await supabase
    .from('meeting_participants')
    .select('id')
    .eq('meeting_id', meetingId)
    .eq('user_id', recorder)
    .is('left_at', null)
    .gt('last_seen_at', presenceCutoff(Date.now()))
    .limit(1);
  return { present: (data?.length ?? 0) > 0, error };
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const body = (await readJson(request)) as {
      recording?: unknown;
      force?: unknown;
    } | null;
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
    // The flag this start replaces: our own, or that of a recorder gone from
    // the call. If they were only cut off and come back, their recorder
    // reads the row naming someone else and stops.
    let replaced: string | null = null;
    if (recording && meeting.recording_started_at) {
      if (meeting.recording_by !== userId) {
        const seen = await recorderInCall(supabase, id, meeting.recording_by);
        if (seen.error) return readErrorResponse(seen.error);
        if (seen.present) return jsonError('already_recording', 409);
      }
      replaced = meeting.recording_started_at;
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
    // Compare-and-set on a start: of two racing managers, one wins, over an
    // empty flag or the one read above. A stop clears only the
    // caller's own, so a newer recording by someone else keeps its
    // indicator, unless a manager forces it.
    const forced = body.force === true && canManage.allowed;
    const { data, error } = await (
      recording
        ? replaced
          ? write.eq('recording_started_at', replaced)
          : write.is('recording_started_at', null)
        : forced
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
    if (!data && recording) return jsonError('already_recording', 409);
    if (!data) {
      // Nothing of ours to clear, or the meeting closed meanwhile. The
      // client takes this answer as the row, so it says what stands now.
      const now = await loadMeeting(supabase, accountId, id);
      if (now.error) return readErrorResponse(now.error);
      if (now.meeting?.status !== 'scheduled') return jsonError(CLOSED, 409);
      return NextResponse.json({
        ok: true,
        recording_started_at: now.meeting.recording_started_at ?? null,
        recording_by: now.meeting.recording_by ?? null,
      });
    }
    return NextResponse.json({ ok: true, ...values });
  } catch (err) {
    return toErrorResponse(err);
  }
}
