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
