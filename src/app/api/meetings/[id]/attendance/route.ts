// ============================================================
// GET /api/meetings/[id]/attendance → `{ attendance, summary }`.
// Who came and for how long, for anyone who can see the meeting: the
// meeting and its seats are both read through the caller's client.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  ATTENDANCE_SEAT_COLUMNS,
  attendanceSummary,
  summarizeAttendance,
  type AttendanceSeat,
} from '@/lib/meetings/attendance';
import { isUuid } from '@/lib/meetings/requests';
import {
  jsonError,
  loadMeeting,
  readAllRows,
  readErrorResponse,
  requireMeetingsUser,
  type Params,
} from '@/lib/meetings/server';

export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    const [loaded, seats] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      readAllRows<AttendanceSeat>(async (from, to) => {
        const { data, error, count } = await supabase
          .from('meeting_participants')
          .select(ATTENDANCE_SEAT_COLUMNS, { count: 'exact' })
          .eq('account_id', accountId)
          .eq('meeting_id', id)
          .order('id')
          .range(from, to);
        return { data: data as AttendanceSeat[] | null, error, count };
      }),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (seats.error) return readErrorResponse(seats.error);
    if (!loaded.meeting) return jsonError('Meeting not found', 404);

    const { ended_at: endedAt } = loaded.meeting;
    const entries = summarizeAttendance(seats.rows, {
      nowMs: Date.now(),
      endedAtMs: endedAt ? Date.parse(endedAt) : null,
    });
    const summary = attendanceSummary(entries);
    return NextResponse.json({
      attendance: entries.map((e) => ({
        user_id: e.userId,
        first_joined_at: e.firstJoinedAt,
        last_left_at: e.lastLeftAt,
        total_ms: e.totalMs,
        seats: e.seats,
        removed: e.removed,
      })),
      summary: {
        people: summary.people,
        started_at: summary.startedAt,
        ended_at: summary.endedAt,
        longest_ms: summary.longestMs,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
