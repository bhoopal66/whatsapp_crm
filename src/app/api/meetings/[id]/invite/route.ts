// ============================================================
// POST /api/meetings/[id]/invite — `{ userIds }` →
// `{ invited, needs_readmit }`.
// Adds people to a meeting already scheduled, through the caller's
// client: 110's INSERT policy (`meeting_is_host`) is what lets it
// happen, and 106's triggers refuse anyone but live staff and ring the
// bell. Someone already invited, and the host, are left out silently.
// Someone the host removed (110) is not invited: an invite would not let
// them in, so they are named in `needs_readmit` instead.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { INVITEES_MAX, isUuid, parseInvite } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  type Params,
} from '@/lib/meetings/server';

const ONLY_THE_HOST = 'Only the organiser can invite people to this meeting';

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const parsed = parseInvite(await readJson(request));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const { meeting, error: readErr } = await loadMeeting(
      supabase,
      accountId,
      id
    );
    if (readErr) return readErrorResponse(readErr);
    if (!meeting) return jsonError('Meeting not found', 404);
    // Not the enforcement (that is the policy, below): a request with
    // nobody new to add never reaches it, and must not answer 200 to
    // someone who may not invite.
    if (meeting.host_user_id.toLowerCase() !== userId.toLowerCase()) {
      return jsonError(ONLY_THE_HOST, 403);
    }
    if (meeting.status !== 'scheduled') {
      return jsonError('This meeting has ended or was cancelled', 409);
    }

    const [{ data: rows, error: inviteesErr }, removed] = await Promise.all([
      supabase.from('meeting_invitees').select('user_id').eq('meeting_id', id),
      supabase
        .from('meeting_removed_users')
        .select('user_id')
        .eq('meeting_id', id)
        .in('user_id', parsed.values.userIds),
    ]);
    if (inviteesErr) return readErrorResponse(inviteesErr);
    if (removed.error) return readErrorResponse(removed.error);
    const needs_readmit = (removed.data ?? []).map((r) => r.user_id as string);
    const invitees = (rows ?? []).map((r) => r.user_id as string);

    const skip = new Set(
      [...invitees, ...needs_readmit, meeting.host_user_id].map((v) =>
        v.toLowerCase()
      )
    );
    const invited = parsed.values.userIds.filter((v) => !skip.has(v));
    if (invited.length === 0) {
      return NextResponse.json({ invited, needs_readmit });
    }
    if (invitees.length + invited.length > INVITEES_MAX) {
      return jsonError(`At most ${INVITEES_MAX} invitees`, 400);
    }

    // One statement, so a refused person adds nobody. Ignoring duplicates
    // keeps a double click from failing on the primary key; a row that
    // already exists is not inserted, so it rings no second bell.
    const { error } = await supabase.from('meeting_invitees').upsert(
      invited.map((user_id) => ({
        meeting_id: id,
        account_id: meeting.account_id,
        user_id,
      })),
      { onConflict: 'meeting_id,user_id', ignoreDuplicates: true }
    );
    if (error) {
      return error.code === '42501'
        ? jsonError(ONLY_THE_HOST, 403)
        : meetingDbErrorResponse(error, 'Failed to invite people');
    }
    return NextResponse.json({ invited, needs_readmit });
  } catch (err) {
    return toErrorResponse(err);
  }
}
