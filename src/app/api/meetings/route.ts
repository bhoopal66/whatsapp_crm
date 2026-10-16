// ============================================================
// /api/meetings — list and schedule video meetings (migration 106).
// Staff only (`requireMeetingsUser` refuses a bank guest). Under the
// caller's RLS client: the list is whatever `meeting_can_view` shows.
// Creating is team leader and up (`canCreateMeetings`, migration 111).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { canCreateMeetings } from '@/lib/auth/roles';
import {
  meetingPhase,
  parseCreateMeeting,
  parseScope,
  presenceCutoff,
} from '@/lib/meetings/requests';
import {
  jsonError,
  MEETING_CREATORS_ONLY,
  meetingDbErrorResponse,
  readJson,
  requireMeetingsUser,
} from '@/lib/meetings/server';
import { MEETING_COLUMNS, type MeetingRow } from '@/lib/meetings/types';

const LIST_LIMIT = 200;

/**
 * GET /api/meetings?scope=live|upcoming|past → `{ meetings }`, each with
 * `invitee_user_ids`, `present_count` (people, not tabs) and
 * `participants`: the present seats as `{ user_id, hand_raised_at }`.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const scope = parseScope(new URL(request.url).searchParams.get('scope'));
    if (!scope) return jsonError('scope must be live, upcoming or past', 400);

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const cutoff = presenceCutoff(now);
    const presentQuery = () =>
      supabase
        .from('meeting_participants')
        .select('meeting_id, user_id, hand_raised_at')
        .eq('account_id', accountId)
        .is('left_at', null)
        .gt('last_seen_at', cutoff);

    let q = supabase
      .from('meetings')
      .select(MEETING_COLUMNS)
      .eq('account_id', accountId);
    if (scope === 'live') {
      const { data: present, error } = await presentQuery();
      if (error)
        return meetingDbErrorResponse(error, 'Failed to load meetings');
      const ids = [
        ...new Set((present ?? []).map((p) => p.meeting_id as string)),
      ];
      if (ids.length === 0) return NextResponse.json({ meetings: [] });
      q = q.eq('status', 'scheduled').in('id', ids);
    } else if (scope === 'upcoming') {
      q = q
        .eq('status', 'scheduled')
        .or(`scheduled_end.is.null,scheduled_end.gt.${nowIso}`)
        .order('scheduled_start', { ascending: true, nullsFirst: true });
    } else {
      q = q
        .or(`status.neq.scheduled,scheduled_end.lt.${nowIso}`)
        .order('created_at', { ascending: false });
    }
    const { data: rows, error } = await q.limit(LIST_LIMIT);
    if (error) return meetingDbErrorResponse(error, 'Failed to load meetings');
    const meetings = (rows ?? []) as MeetingRow[];
    if (meetings.length === 0) return NextResponse.json({ meetings: [] });

    const ids = meetings.map((m) => m.id);
    const [invitees, present] = await Promise.all([
      supabase
        .from('meeting_invitees')
        .select('meeting_id, user_id')
        .in('meeting_id', ids),
      presentQuery().in('meeting_id', ids),
    ]);
    const failed = invitees.error ?? present.error;
    if (failed)
      return meetingDbErrorResponse(failed, 'Failed to load meetings');

    const inviteesOf = new Map<string, string[]>();
    for (const r of invitees.data ?? []) {
      const list = inviteesOf.get(r.meeting_id) ?? [];
      list.push(r.user_id);
      inviteesOf.set(r.meeting_id, list);
    }
    const presentOf = new Map<string, Set<string>>();
    const seatsOf = new Map<
      string,
      { user_id: string; hand_raised_at: string | null }[]
    >();
    for (const r of present.data ?? []) {
      const set = presentOf.get(r.meeting_id) ?? new Set<string>();
      set.add(r.user_id);
      presentOf.set(r.meeting_id, set);
      const seats = seatsOf.get(r.meeting_id) ?? [];
      seats.push({ user_id: r.user_id, hand_raised_at: r.hand_raised_at });
      seatsOf.set(r.meeting_id, seats);
    }
    return NextResponse.json({
      meetings: meetings
        .map((m) => ({
          ...m,
          invitee_user_ids: inviteesOf.get(m.id) ?? [],
          present_count: presentOf.get(m.id)?.size ?? 0,
          participants: seatsOf.get(m.id) ?? [],
        }))
        .filter((m) => meetingPhase(m, m.present_count, now) === scope),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/meetings → 201 `{ meeting }`, the caller as host. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireMeetingsUser();
    if (!canCreateMeetings(role)) return jsonError(MEETING_CREATORS_ONLY, 403);
    const parsed = parseCreateMeeting(await readJson(request));
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { meeting: values, inviteeUserIds } = parsed.values;

    const { data, error } = await supabase
      .from('meetings')
      .insert({ ...values, account_id: accountId, host_user_id: userId })
      .select(MEETING_COLUMNS)
      .single();
    if (error) return meetingDbErrorResponse(error, 'Failed to create meeting');
    const meeting = data as MeetingRow;

    if (inviteeUserIds.length > 0) {
      const { error: invErr } = await supabase.from('meeting_invitees').insert(
        inviteeUserIds.map((user_id) => ({
          meeting_id: meeting.id,
          account_id: accountId,
          user_id,
        }))
      );
      if (invErr) {
        // All or nothing: a refused invitee (another workspace, a guest)
        // must not leave a half-made meeting behind.
        await supabase.from('meetings').delete().eq('id', meeting.id);
        return meetingDbErrorResponse(invErr, 'Failed to invite people');
      }
    }
    return NextResponse.json(
      {
        meeting: {
          ...meeting,
          invitee_user_ids: inviteeUserIds,
          present_count: 0,
          participants: [],
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
