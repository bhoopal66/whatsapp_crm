// ============================================================
// /api/meetings/[id]/messages — the meeting's chat and reactions (107).
//
// POST `{ kind: 'chat' | 'reaction', body }` → 201 `{ message }`, written
// by `meeting_post_message` under the caller's own client: the function
// checks visibility, that the meeting is still scheduled, the body rules
// and the rate limit, and stamps user_id = auth.uid(). No service role.
//
// GET `?kind=chat|reaction&before=<iso>&limit=1..200` → `{ messages }`,
// the latest `limit` before `before` (default: now), ascending. Reads
// go through RLS (the meeting's own visibility).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  isUuid,
  parseMessagePost,
  parseMessageQuery,
} from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  type Params,
} from '@/lib/meetings/server';
import { MESSAGE_COLUMNS, type MeetingMessage } from '@/lib/meetings/types';

const CLOSED = 'This meeting has ended or was cancelled';

/** `meeting_post_message`'s refusals, as 107 raises them. */
function postErrorResponse(error: {
  code?: string;
  message?: string;
}): NextResponse {
  const message = error.message ?? '';
  if (error.code === '42501') return jsonError('Meeting not found', 404);
  if (error.code === 'P0001' && /^rate_limited\b/.test(message)) {
    return jsonError('rate_limited', 429);
  }
  if (error.code === 'P0001' && /^removed\b/.test(message)) {
    return jsonError('removed_from_meeting', 403);
  }
  if (error.code === 'P0001' && /^meeting_closed\b/.test(message)) {
    return jsonError(CLOSED, 409);
  }
  if (error.code === '22023') return jsonError('Invalid message', 400);
  console.error('[meetings] posting a message failed', error);
  return jsonError('Failed to send the message', 500);
}

const pick = (r: MeetingMessage): MeetingMessage => ({
  id: r.id,
  user_id: r.user_id,
  kind: r.kind,
  body: r.body,
  created_at: r.created_at,
});

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const parsed = parseMessagePost(await readJson(request));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const { data, error } = await supabase.rpc('meeting_post_message', {
      p_meeting: id,
      p_kind: parsed.values.kind,
      p_body: parsed.values.body,
    });
    if (error?.code === '42501') {
      // Since 112 a removal hides the meeting, so the function refuses
      // it as not visible; the caller reads their own removal (110's
      // policy) to be told why.
      const { data: removal } = await supabase
        .from('meeting_removed_users')
        .select('user_id')
        .eq('meeting_id', id)
        .eq('user_id', userId)
        .maybeSingle();
      if (removal) return jsonError('removed_from_meeting', 403);
    }
    if (error) return postErrorResponse(error);
    const row = (Array.isArray(data) ? data[0] : data) as MeetingMessage | null;
    if (!row) return jsonError('Failed to send the message', 500);
    return NextResponse.json({ message: pick(row) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const parsed = parseMessageQuery(new URL(request.url).searchParams);
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { kind, before, limit } = parsed.values;

    let q = supabase
      .from('meeting_messages')
      .select(MESSAGE_COLUMNS)
      .eq('meeting_id', id)
      .eq('kind', kind);
    if (before) q = q.lt('created_at', before);
    const [loaded, rows] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      // Newest first so `limit` keeps the latest; reversed below.
      q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (!loaded.meeting) return jsonError('Meeting not found', 404);
    if (rows.error) return readErrorResponse(rows.error);
    const messages = ((rows.data ?? []) as MeetingMessage[])
      .map(pick)
      .reverse();
    return NextResponse.json({ messages });
  } catch (err) {
    return toErrorResponse(err);
  }
}
