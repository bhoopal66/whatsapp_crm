/**
 * The Live view (/live, Track B item 8, migration 238): who is online
 * and how their customers are doing, right now.
 *
 * `live_team_view()` returns the whole page as one jsonb (one round
 * trip, like Team activity's report): owners and admins get every live
 * staff member and the unassigned waiting count, a team leader the
 * people in the teams they lead plus themselves. Presence is derived in
 * SQL with the same 75 s rule as `derivePresence` (`lib/presence.ts`).
 * This module parses that defensively and orders the people. Pure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { PresenceStatus } from '@/lib/presence';

/** How often the page re-reads the view while it is open. */
export const LIVE_REFRESH_MS = 30_000;

export interface LivePerson {
  /** Auth user id. */
  userId: string;
  name: string;
  role: string;
  presence: PresenceStatus;
  lastSeenAt: string | null;
  /** Open company chats assigned to them. */
  openChats: number;
  /** Of those, the ones whose customer is waiting for a reply (237). */
  waitingChats: number;
  oldestWaitingSince: string | null;
  oldestWaitingBusinessMinutes: number | null;
  /** Agent messages they sent today (workspace time zone), not failed. */
  repliesToday: number;
}

export interface LiveTeamView {
  people: LivePerson[];
  /** Owners and admins only; null for a team leader. */
  unassignedWaiting: number | null;
  timezone: string;
  /** 'all': the whole workspace; 'team': a leader's teams. */
  scope: 'all' | 'team';
  generatedAt: string | null;
}

type Row = Record<string, unknown>;

const PRESENCE: readonly PresenceStatus[] = ['online', 'away', 'offline'];

function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function time(v: unknown): string | null {
  const s = text(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
}

function person(raw: unknown): LivePerson | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Row;
  const userId = text(r.user_id);
  if (!userId) return null;
  const presence = PRESENCE.includes(r.presence as PresenceStatus)
    ? (r.presence as PresenceStatus)
    : 'offline';
  const oldest = time(r.oldest_waiting_since);
  const bm = Number(r.oldest_waiting_business_minutes);
  return {
    userId,
    name: text(r.name) ?? text(r.email) ?? '',
    role: text(r.role) ?? '',
    presence,
    lastSeenAt: time(r.last_seen_at),
    openChats: count(r.open_chats),
    waitingChats: count(r.waiting_chats),
    oldestWaitingSince: oldest,
    oldestWaitingBusinessMinutes:
      oldest && r.oldest_waiting_business_minutes != null && Number.isFinite(bm)
        ? Math.max(0, Math.floor(bm))
        : null,
    repliesToday: count(r.replies_today),
  };
}

/** Parse the RPC's jsonb; null when it is not the view's shape at all. */
export function parseLiveTeamView(raw: unknown): LiveTeamView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Row;
  if (!Array.isArray(r.people)) return null;
  const people = r.people
    .map(person)
    .filter((p): p is LivePerson => p !== null);
  return {
    people: sortLivePeople(people),
    unassignedWaiting:
      r.unassigned_waiting === null || r.unassigned_waiting === undefined
        ? null
        : count(r.unassigned_waiting),
    timezone: text(r.timezone) ?? 'Asia/Dubai',
    scope: r.scope === 'all' ? 'all' : 'team',
    generatedAt: time(r.generated_at),
  };
}

const PRESENCE_ORDER: Record<PresenceStatus, number> = {
  online: 0,
  away: 1,
  offline: 2,
};

/**
 * Whose customers have waited longest first; then the people with
 * nobody waiting, online before away before offline, by name.
 */
export function sortLivePeople(people: readonly LivePerson[]): LivePerson[] {
  return [...people].sort((a, b) => {
    const wa = a.oldestWaitingSince ? Date.parse(a.oldestWaitingSince) : null;
    const wb = b.oldestWaitingSince ? Date.parse(b.oldestWaitingSince) : null;
    if (wa !== null && wb !== null && wa !== wb) return wa - wb;
    if (wa !== null && wb === null) return -1;
    if (wa === null && wb !== null) return 1;
    return (
      PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence] ||
      a.name.localeCompare(b.name) ||
      a.userId.localeCompare(b.userId)
    );
  });
}

export type LiveLoadResult =
  | { ok: true; view: LiveTeamView }
  | { ok: false; reason: 'not_allowed' | 'failed' };

/** Read the view; never throws. */
export async function loadLiveTeamView(
  supabase: SupabaseClient
): Promise<LiveLoadResult> {
  try {
    const { data, error } = await supabase.rpc('live_team_view');
    if (error) {
      return {
        ok: false,
        reason: error.code === '42501' ? 'not_allowed' : 'failed',
      };
    }
    const view = parseLiveTeamView(data);
    return view ? { ok: true, view } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
