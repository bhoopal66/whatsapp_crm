// ============================================================
// /api/meetings/[id] — one meeting: read, change, cancel (106).
// Reads under the caller's RLS client (404 when they can't see it);
// changes need `meeting_can_manage` (host, owner, admin).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  diffInvitees,
  isUuid,
  parseMeetingPatch,
  presenceCutoff,
} from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  rpcFlag,
  type Params,
} from '@/lib/meetings/server';
import { MEETING_COLUMNS, PARTICIPANT_COLUMNS } from '@/lib/meetings/types';

const NOT_FOUND = 'Meeting not found';

/** GET → `{ meeting, invitee_user_ids, participants, can_manage }`. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    const [loaded, invitees, present, canManage] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      supabase.from('meeting_invitees').select('user_id').eq('meeting_id', id),
      supabase
        .from('meeting_participants')
        .select(PARTICIPANT_COLUMNS)
        .eq('meeting_id', id)
        .is('left_at', null)
        .gt('last_seen_at', presenceCutoff(Date.now())),
      rpcFlag(supabase, 'meeting_can_manage', id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (!loaded.meeting) return jsonError(NOT_FOUND, 404);
    return NextResponse.json({
      meeting: loaded.meeting,
      invitee_user_ids: (invitees.data ?? []).map((r) => r.user_id),
      participants: present.data ?? [],
      can_manage: canManage,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH → `{ meeting, invitee_user_ids }`. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const body = await readJson(request);

    const [loaded, canManage] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      rpcFlag(supabase, 'meeting_can_manage', id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    const current = loaded.meeting;
    if (!current) return jsonError(NOT_FOUND, 404);
    if (!canManage) {
      return jsonError(
        'Only the host or an admin can change this meeting',
        403
      );
    }
    if (current.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }
    const parsed = parseMeetingPatch(body, current);
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { meeting: values, inviteeUserIds } = parsed.values;

    const { data: inv, error: invErr } = await supabase
      .from('meeting_invitees')
      .select('user_id')
      .eq('meeting_id', id);
    if (invErr)
      return meetingDbErrorResponse(invErr, 'Failed to load invitees');
    let invitees = (inv ?? []).map((r) => r.user_id as string);
    if (inviteeUserIds !== undefined) {
      const { add, remove } = diffInvitees(invitees, inviteeUserIds);
      // Invitee changes go first, additions before removals: a refused
      // invitee (not a live staff member: 23514) then changes nothing.
      if (add.length > 0) {
        const { error } = await supabase.from('meeting_invitees').insert(
          add.map((user_id) => ({
            meeting_id: id,
            account_id: current.account_id,
            user_id,
          }))
        );
        if (error)
          return meetingDbErrorResponse(error, 'Failed to invite people');
      }
      if (remove.length > 0) {
        const { error } = await supabase
          .from('meeting_invitees')
          .delete()
          .eq('meeting_id', id)
          .in('user_id', remove);
        if (error)
          return meetingDbErrorResponse(error, 'Failed to update invitees');
      }
      invitees = inviteeUserIds;
    }
    let meeting = current;
    if (Object.keys(values).length > 0) {
      const { data, error } = await supabase
        .from('meetings')
        .update(values)
        .eq('account_id', accountId)
        .eq('id', id)
        .select(MEETING_COLUMNS)
        .maybeSingle();
      if (error)
        return meetingDbErrorResponse(error, 'Failed to update meeting');
      if (!data) return jsonError(NOT_FOUND, 404);
      meeting = data;
    }

    return NextResponse.json({ meeting, invitee_user_ids: invitees });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE → cancels (status 'cancelled'); `{ meeting }`. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    const [loaded, canManage] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      rpcFlag(supabase, 'meeting_can_manage', id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (!loaded.meeting) return jsonError(NOT_FOUND, 404);
    if (!canManage) {
      return jsonError(
        'Only the host or an admin can cancel this meeting',
        403
      );
    }
    if (loaded.meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }
    const { data, error } = await supabase
      .from('meetings')
      .update({ status: 'cancelled' })
      .eq('account_id', accountId)
      .eq('id', id)
      .eq('status', 'scheduled')
      .select(MEETING_COLUMNS)
      .maybeSingle();
    if (error) return meetingDbErrorResponse(error, 'Failed to cancel meeting');
    if (!data) return jsonError('This meeting has ended or was cancelled', 409);
    return NextResponse.json({ meeting: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
