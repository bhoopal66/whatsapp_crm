// ============================================================
// Cutting a seat's media at Cloudflare (M1).
//
// Closing a participant row only stamps the database; the Cloudflare
// session keeps relaying every track it had published or pulled, so a
// client that ignores the 404/409 would keep receiving the call. The
// routes that end a seat (leave, end, a PATCH that takes access away)
// therefore also close the session's tracks with `force: true`, which
// per the SFU's OpenAPI schema stops their media flow without an SDP
// exchange (no sessionDescription), for published and pulled tracks
// alike.
//
// Best-effort by contract: awaited by the caller, never throws, and
// a no-op when the SFU is not configured. The seat is already closed in
// the database, so a Cloudflare failure is logged and nothing more.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { closeTracks, getSession, isMeetingsConfigured } from './sfu';
import type { ParticipantRow } from './types';

export type SeatToCut = Pick<ParticipantRow, 'cf_session_id'>;

async function cutSession(sessionId: string): Promise<void> {
  const state = await getSession(sessionId);
  // `inactive` is already closed; anything else (active, or a track
  // with no status) may still be forwarding.
  const mids = (state.tracks ?? [])
    .filter((t) => t.status !== 'inactive')
    .map((t) => t.mid)
    .filter((mid): mid is string => typeof mid === 'string' && mid !== '');
  // The schema requires at least one track per close request.
  if (mids.length === 0) return;
  await closeTracks(sessionId, {
    tracks: mids.map((mid) => ({ mid })),
    force: true,
  });
}

/** Close every open track of each seat's Cloudflare session. */
export async function cutSeats(seats: readonly SeatToCut[]): Promise<void> {
  if (!isMeetingsConfigured()) return;
  const sessions = [
    ...new Set(seats.map((s) => s.cf_session_id).filter(Boolean)),
  ];
  await Promise.all(
    sessions.map((sid) =>
      cutSession(sid).catch((err: unknown) => {
        const e = err as { status?: unknown; code?: unknown } | null;
        // 410: the session is gone already, so there is nothing to cut.
        if (e?.status === 410) return;
        console.error('[meetings] cutting a seat failed', e?.status, e?.code);
      })
    )
  );
}

/** How long an admin's answer may wait for a departed member's cut. */
export const MEMBER_CUT_WAIT_MS = 5_000;

/**
 * A person who may no longer be here (deactivated or removed) is taken
 * out of the meetings of `accountId` they are sitting in: their open
 * seats are closed as a leave closes them, then cut at Cloudflare, which
 * would otherwise keep relaying every track already pulled.
 *
 * Never throws, and answers within MEMBER_CUT_WAIT_MS; work still under
 * way then carries on. A seat this misses is the minute sweep's
 * (`runSeatAccessSweep`). `admin` is the service role; the caller has
 * authorised the departure.
 */
export async function cutMemberSeats(
  admin: SupabaseClient,
  accountId: string,
  userId: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error('[meetings] cutting a departed member is slow');
      resolve();
    }, MEMBER_CUT_WAIT_MS);
  });
  const work = closeMemberSeats(admin, accountId, userId).catch(
    (err: unknown) => {
      const e = err as { code?: unknown; name?: unknown } | null;
      console.error(
        '[meetings] a departed member kept their seats',
        e?.code ?? e?.name
      );
    }
  );
  await Promise.race([work, bound]);
  clearTimeout(timer);
}

async function closeMemberSeats(
  admin: SupabaseClient,
  accountId: string,
  userId: string
): Promise<void> {
  const { data, error } = await admin
    .from('meeting_participants')
    .update({ left_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .is('left_at', null)
    .select('cf_session_id');
  if (error) throw error;
  await cutSeats((data ?? []) as SeatToCut[]);
}
