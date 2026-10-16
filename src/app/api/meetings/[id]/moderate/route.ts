// ============================================================
// POST /api/meetings/[id]/moderate — `{ target, action }` (107).
// Host, owner or admin only (`meeting_can_manage`, caller's client);
// the target must be an open seat of this meeting. Then, service role:
//   mute       → mute_requested_at = now (the client mutes itself)
//   lower_hand → hand_raised_at = null
//   remove     → left_at = removed_at = now, removed_by = caller, and
//                the seat's Cloudflare media is cut (`cutSeats`), so a
//                client that ignores it stops sending and receiving.
// Nobody removes themselves (that is Leave), and nobody removes someone
// who could manage the meeting (the host, a live owner/admin of its
// account): they would only readmit themselves. A removal sticks (110):
// the person is recorded in meeting_removed_users first, so join and chat
// refuse them until `readmit` (target = their user id, not a seat)
// deletes the row; 404 when they were not removed. Nobody readmits
// themselves. A removal closes and cuts every open seat the person has
// here (another tab's too), not only the one named.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { cutSeats } from '@/lib/meetings/cut';
import { isUuid, parseModeration } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  rpcFlag,
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';
import { PARTICIPANT_COLUMNS, type ParticipantRow } from '@/lib/meetings/types';

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const parsed = parseModeration(await readJson(request));
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { target, action } = parsed.values;

    const [loaded, canManage, seat] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      rpcFlag(supabase, 'meeting_can_manage', id),
      action === 'readmit'
        ? Promise.resolve({ data: null, error: null })
        : supabase
            .from('meeting_participants')
            .select(PARTICIPANT_COLUMNS)
            .eq('id', target)
            .eq('meeting_id', id)
            .maybeSingle(),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canManage.error) return readErrorResponse(canManage.error);
    if (!loaded.meeting) return jsonError('Meeting not found', 404);
    if (!canManage.allowed) {
      return jsonError(
        'Only the host or an admin can moderate this meeting',
        403
      );
    }
    if (loaded.meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }
    if (action === 'readmit') {
      if (target === userId) {
        return jsonError("You can't let yourself back in", 403);
      }
      const { data: readmitted, error } = await supabaseAdmin()
        .from('meeting_removed_users')
        .delete()
        .eq('meeting_id', id)
        .eq('user_id', target)
        .select('user_id');
      if (error) return meetingDbErrorResponse(error, 'Failed to moderate');
      if (!readmitted?.length) {
        return jsonError('That person was not removed from this meeting', 404);
      }
      return NextResponse.json({ ok: true });
    }
    if (seat.error) return readErrorResponse(seat.error);
    const row = seat.data as ParticipantRow | null;
    if (!row || row.left_at) {
      return jsonError('That person is not in this meeting', 404);
    }
    if (action === 'remove' && row.user_id === userId) {
      return jsonError(
        "You can't remove yourself; leave the meeting instead",
        400
      );
    }

    if (action === 'remove') {
      if (row.user_id === loaded.meeting.host_user_id) {
        return jsonError("You can't remove the organiser or an admin", 403);
      }
      // Service role: the caller's RLS may not show another member's row.
      const { data: manager, error: managerErr } = await supabaseAdmin()
        .from('profiles')
        .select('id')
        .eq('account_id', loaded.meeting.account_id)
        .eq('user_id', row.user_id)
        // account_role, never the legacy `role` column: anyone may write
        // that one on their own row.
        .in('account_role', ['owner', 'admin'])
        .is('deactivated_at', null)
        .limit(1);
      if (managerErr) return readErrorResponse(managerErr);
      if (manager?.length) {
        return jsonError("You can't remove the organiser or an admin", 403);
      }
    }

    const now = new Date().toISOString();
    if (action === 'remove') {
      // Recorded before the seat closes, so a rejoin racing the close is
      // already refused.
      const { error } = await supabaseAdmin()
        .from('meeting_removed_users')
        .upsert(
          {
            meeting_id: id,
            account_id: loaded.meeting.account_id,
            user_id: row.user_id,
            removed_by: userId,
            removed_at: now,
          },
          { onConflict: 'meeting_id,user_id' }
        );
      if (error) return meetingDbErrorResponse(error, 'Failed to moderate');
    }
    const update =
      action === 'mute'
        ? { mute_requested_at: now }
        : action === 'lower_hand'
          ? { hand_raised_at: null }
          : { left_at: now, removed_at: now, removed_by: userId };
    // A removal closes every open seat the person has in this meeting;
    // mute and lower_hand touch only the named seat.
    const write = supabaseAdmin()
      .from('meeting_participants')
      .update(update)
      .eq('meeting_id', id);
    const scoped =
      action === 'remove'
        ? write.eq('user_id', row.user_id)
        : write.eq('id', row.id);
    const { data: changed, error } = await scoped
      .is('left_at', null)
      .select('id, cf_session_id');
    if (error) return meetingDbErrorResponse(error, 'Failed to moderate');
    // The seat closed between the lookup and the write (the person left or
    // rejoined on a new seat): nothing changed, so cut nothing and say so.
    if (!changed?.length) {
      return jsonError('That person is not in this meeting', 404);
    }
    if (action === 'remove') {
      await cutSeats(changed as Pick<ParticipantRow, 'cf_session_id'>[]);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
