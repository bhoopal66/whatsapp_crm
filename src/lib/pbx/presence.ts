/**
 * Phone presence (Yeastar 30008 call state + 30009 status) as people's
 * dots read it. Pure and free of server imports: the browser's presence
 * hook (src/hooks/use-phone-presence.ts) imports it, and calls.ts, which
 * imports next/server, re-exports it for the server side. Importing it
 * through calls.ts from client code pulled next/server (node:async_hooks)
 * into the browser bundle and broke the production build.
 */

export type PresenceView =
  'available' | 'on_call' | 'away' | 'dnd' | 'off_work';

/** A call state not written for this long is a call end never reported. */
export const PRESENCE_STALE_MS = 10 * 60_000;

export interface PresenceRow {
  user_id: string | null;
  extension: string;
  presence: string | null;
  call_state: string | null;
  updated_at: string;
}

/**
 * A call (Yeastar's per-extension `ringing` / `busy`) first, then the
 * status the person chose. Yeastar sends both only when they change, so
 * the chosen status holds until the next one: it never expires here. A
 * call state does: the processor writes every change and the PBX cron
 * (pbx_presence_keepalive, migration 101) refreshes a ringing or busy
 * row while its call is live, so one older than PRESENCE_STALE_MS is an
 * end the PBX never reported, and the chosen status shows instead.
 * Lunch and business trip read as away; no status yet reads as
 * available.
 */
export function presenceView(row: PresenceRow, now: number): PresenceView {
  const at = Date.parse(row.updated_at);
  const onCall =
    (row.call_state === 'ringing' || row.call_state === 'busy') &&
    Number.isFinite(at) &&
    now - at <= PRESENCE_STALE_MS;
  if (onCall) return 'on_call';
  switch (row.presence) {
    case 'away':
    case 'lunch':
    case 'business_trip':
      return 'away';
    case 'do_not_disturb':
      return 'dnd';
    case 'off_work':
      return 'off_work';
    default:
      return 'available';
  }
}

export interface UserPresence {
  state: PresenceView;
  extension: string;
  updatedAt: string;
}

/** By user id; a person on two connections shows their freshest row. */
export function presenceByUser(
  rows: PresenceRow[],
  now: number
): Record<string, UserPresence> {
  const out: Record<string, UserPresence> = {};
  for (const r of rows) {
    if (!r.user_id) continue;
    const prev = out[r.user_id];
    if (prev && Date.parse(prev.updatedAt) >= Date.parse(r.updated_at))
      continue;
    out[r.user_id] = {
      state: presenceView(r, now),
      extension: r.extension,
      updatedAt: r.updated_at,
    };
  }
  return out;
}
