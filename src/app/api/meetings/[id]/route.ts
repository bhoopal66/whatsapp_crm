// ============================================================
// /api/meetings/[id] — one meeting: read, change, cancel (106).
// Reads under the caller's RLS client (404 when they can't see it);
// a PATCH is the host's alone; cancelling needs `meeting_can_manage`
// (host, owner, admin). A PATCH that
// takes access away closes and cuts the seats of the people who lost it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { hasMinRole, isAccountRole } from '@/lib/auth/roles';
import { cutSeats } from '@/lib/meetings/cut';
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
  supabaseAdmin,
  type Params,
} from '@/lib/meetings/server';
import {
  MEETING_COLUMNS,
  PARTICIPANT_COLUMNS,
  type MeetingRow,
} from '@/lib/meetings/types';

const NOT_FOUND = 'Meeting not found';

/**
 * After a PATCH left the meeting closed to the workspace: close the open
 * seats of everyone who can no longer see it (not the host, not an
 * invitee, not a live owner/admin of its workspace) and cut their
 * Cloudflare sessions. Their next heartbeat is refused by RLS anyway;
 * this stops media a client that ignores the 404 is already pulling.
 *
 * Best-effort: the edit itself is committed, so a failure here is
 * logged, never answered. Judged from the state, not the diff, so a
 * repeated PATCH finishes what a failed one left.
 */
async function evictSeatsWithoutAccess(
  supabase: SupabaseClient,
  meeting: MeetingRow,
  invitees: readonly string[]
): Promise<void> {
  const { data: open, error } = await supabase
    .from('meeting_participants')
    .select('id, user_id, cf_session_id')
    .eq('meeting_id', meeting.id)
    .is('left_at', null);
  if (error) {
    console.error('[meetings] reading seats to evict failed', error);
    return;
  }
  const keep = new Set(
    [meeting.host_user_id, ...invitees].map((u) => u.toLowerCase())
  );
  const candidates = (open ?? []).filter(
    (s) => !keep.has(String(s.user_id).toLowerCase())
  );
  if (candidates.length === 0) return;

  const admin = supabaseAdmin();
  const { data: profiles, error: profErr } = await admin
    .from('profiles')
    .select('user_id, role')
    .eq('account_id', meeting.account_id)
    .in('user_id', [...new Set(candidates.map((s) => s.user_id))])
    .is('deactivated_at', null);
  if (profErr) {
    console.error('[meetings] reading roles to evict failed', profErr);
    return;
  }
  const admins = new Set(
    (profiles ?? [])
      .filter((p) => isAccountRole(p.role) && hasMinRole(p.role, 'admin'))
      .map((p) => p.user_id as string)
  );
  const evicted = candidates.filter((s) => !admins.has(s.user_id));
  if (evicted.length === 0) return;

  const { error: closeErr } = await admin
    .from('meeting_participants')
    .update({ left_at: new Date().toISOString() })
    .in(
      'id',
      evicted.map((s) => s.id)
    )
    .is('left_at', null);
  if (closeErr) console.error('[meetings] closing seats failed', closeErr);
  await cutSeats(evicted);
}

/**
 * GET → `{ meeting, invitee_user_ids, participants, can_manage,
 * chat_count }`. `participants` are the present seats (hand_raised_at
 * included); `chat_count` counts the chat lines (not reactions).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    const [loaded, invitees, present, canManage, chat] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      supabase.from('meeting_invitees').select('user_id').eq('meeting_id', id),
      supabase
        .from('meeting_participants')
        .select(PARTICIPANT_COLUMNS)
        .eq('meeting_id', id)
        .is('left_at', null)
        .gt('last_seen_at', presenceCutoff(Date.now())),
      rpcFlag(supabase, 'meeting_can_manage', id),
      supabase
        .from('meeting_messages')
        .select('id', { count: 'exact', head: true })
        .eq('meeting_id', id)
        .eq('kind', 'chat'),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (canManage.error) return readErrorResponse(canManage.error);
    if (!loaded.meeting) return jsonError(NOT_FOUND, 404);
    if (chat.error) return readErrorResponse(chat.error);
    // Not an empty list: the edit dialog saves the invitees it was shown,
    // so a failed read would PATCH every invitee away and evict them.
    if (invitees.error) return readErrorResponse(invitees.error);
    if (present.error) return readErrorResponse(present.error);
    return NextResponse.json({
      meeting: loaded.meeting,
      invitee_user_ids: (invitees.data ?? []).map((r) => r.user_id),
      participants: present.data ?? [],
      can_manage: canManage.allowed,
      chat_count: chat.count ?? 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH → `{ meeting, invitee_user_ids }`. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const body = await readJson(request);

    const loaded = await loadMeeting(supabase, accountId, id);
    if (loaded.error) return readErrorResponse(loaded.error);
    const current = loaded.meeting;
    if (!current) return jsonError(NOT_FOUND, 404);
    // Editing is the organiser's alone, owners and admins included: a
    // meeting is someone's invitation, and its title, time and invitee
    // list are theirs to change. An admin still cancels (DELETE), ends
    // and moderates through their own routes.
    if (current.host_user_id.toLowerCase() !== userId.toLowerCase()) {
      return jsonError('Only the organiser can edit this meeting', 403);
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
    let removedInvitees = false;
    if (inviteeUserIds !== undefined) {
      const { add, remove } = diffInvitees(invitees, inviteeUserIds);
      removedInvitees = remove.length > 0;
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
    if (
      !meeting.open_to_workspace &&
      (removedInvitees || current.open_to_workspace)
    ) {
      await evictSeatsWithoutAccess(supabase, meeting, invitees);
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
    if (canManage.error) return readErrorResponse(canManage.error);
    if (!loaded.meeting) return jsonError(NOT_FOUND, 404);
    if (!canManage.allowed) {
      return jsonError(
        'Only the host or an admin can cancel this meeting',
        403
      );
    }
    if (loaded.meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }
    // Before the update, as in end: entering 'cancelled' closes them.
    const seats = await supabase
      .from('meeting_participants')
      .select('cf_session_id')
      .eq('meeting_id', id)
      .is('left_at', null);
    if (seats.error) return readErrorResponse(seats.error);
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
    await cutSeats(seats.data ?? []);
    return NextResponse.json({ meeting: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
