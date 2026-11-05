import type { SupabaseClient } from '@supabase/supabase-js';
import { PRESENCE_WINDOW_MS } from './types';

/**
 * An instant meeting (Start now: no scheduled_start) has no end time, so
 * it closes when nobody has been in it for this long. The grace lets
 * someone who dropped out rejoin.
 */
export const INSTANT_LAPSE_MS = 10 * 60_000;

export interface LapseMeeting {
  id: string;
  status: string;
  scheduled_start: string | null;
  created_at: string;
}

export interface LapseSeat {
  meeting_id: string;
  joined_at: string;
  last_seen_at: string;
  left_at: string | null;
}

/**
 * Ids of instant meetings that should end now. Pure. Unparseable dates
 * count as not lapsed: never end a meeting on bad data.
 */
export function lapsedInstantMeetings(
  meetings: LapseMeeting[],
  seats: LapseSeat[],
  nowMs: number
): string[] {
  const seatsByMeeting = new Map<string, LapseSeat[]>();
  for (const s of seats) {
    const list = seatsByMeeting.get(s.meeting_id);
    if (list) list.push(s);
    else seatsByMeeting.set(s.meeting_id, [s]);
  }

  const lapsed: string[] = [];
  for (const m of meetings) {
    if (m.status !== 'scheduled' || m.scheduled_start !== null) continue;

    let latest = Date.parse(m.created_at);
    if (Number.isNaN(latest)) continue;

    let bad = false;
    let present = false;
    for (const s of seatsByMeeting.get(m.id) ?? []) {
      const seen = Date.parse(s.last_seen_at);
      const left = s.left_at === null ? null : Date.parse(s.left_at);
      if (Number.isNaN(seen) || (left !== null && Number.isNaN(left))) {
        bad = true;
        break;
      }
      if (left === null && nowMs - seen <= PRESENCE_WINDOW_MS) present = true;
      latest = Math.max(latest, left ?? seen);
    }
    if (bad || present) continue;

    if (nowMs - latest > INSTANT_LAPSE_MS) lapsed.push(m.id);
  }
  return lapsed;
}

/** Oldest first, so a backlog clears over a few passes. */
const SWEEP_LIMIT = 100;
/** Newest first, so PostgREST's row cap can only ever drop old seats. */
const SEATS_READ = 1000;

/**
 * Ends instant meetings nobody is in any more. The meetings_guard trigger
 * stamps ended_at and closes open seat rows, so ending a meeting someone
 * is in would cut their call: each meeting's seats are read on their own,
 * right before deciding. One read for the whole batch could be cut short
 * by the row cap, making a busy meeting look empty, and would be stale by
 * the end of the loop. A failed seat read skips that meeting, because no
 * answer is not the same as an empty room. The candidates' read throws;
 * a failed update is logged and the sweep goes on.
 */
export async function runMeetingLapseSweep(
  admin: SupabaseClient
): Promise<{ checked: number; ended: number }> {
  const cutoff = new Date(Date.now() - INSTANT_LAPSE_MS).toISOString();

  const { data: meetings, error } = await admin
    .from('meetings')
    .select('id, status, scheduled_start, created_at')
    .eq('status', 'scheduled')
    .is('scheduled_start', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(SWEEP_LIMIT);
  if (error) throw new Error(error.message);
  if (!meetings || meetings.length === 0) return { checked: 0, ended: 0 };

  let ended = 0;
  for (const m of meetings as LapseMeeting[]) {
    const { data: seats, error: seatError } = await admin
      .from('meeting_participants')
      .select('meeting_id, joined_at, last_seen_at, left_at')
      .eq('meeting_id', m.id)
      .order('last_seen_at', { ascending: false })
      .limit(SEATS_READ);
    if (seatError) {
      console.error(
        '[meeting-lapse] could not read seats:',
        m.id,
        seatError.message
      );
      continue;
    }
    const lapsed = lapsedInstantMeetings(
      [m],
      (seats ?? []) as LapseSeat[],
      Date.now()
    );
    if (lapsed.length === 0) continue;
    // Still instant: a PATCH may have scheduled it since the read above.
    const { error: updateError } = await admin
      .from('meetings')
      .update({ status: 'ended' })
      .eq('id', m.id)
      .eq('status', 'scheduled')
      .is('scheduled_start', null);
    if (updateError) {
      console.error(
        '[meeting-lapse] could not end meeting:',
        m.id,
        updateError.message
      );
      continue;
    }
    ended += 1;
  }
  return { checked: meetings.length, ended };
}
