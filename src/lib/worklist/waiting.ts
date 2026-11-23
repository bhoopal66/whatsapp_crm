/**
 * "Customers waiting for a reply" at the top of My worklist (Track B
 * item 9, migration 238).
 *
 * The rows come from `worklist_waiting_chats` (SECURITY INVOKER: the
 * conversations policies decide which chats a person sees at all), using
 * 237's one definition of waiting (`conversation_waiting_since`): a
 * company chat, not closed, whose customer wrote last. Oldest first.
 * This module parses them, narrows them to the worklist's filter (a
 * filter over what RLS returned, never a grant) and says how long. Pure
 * apart from `loadWaitingChats`, which never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { WorklistMode } from './rank';
import { durationParts, type DurationUnit } from './timing';

/** The RPC's own cap is 200; the worklist asks for this many. */
export const WAITING_CHATS_LIMIT = 100;

export interface WaitingChat {
  conversationId: string;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  /** Auth user id of the assignee; null: nobody is assigned. */
  assignedAgentId: string | null;
  /** ISO time the customer started waiting. */
  waitingSince: string;
  /** Business minutes waited, in the workspace's hours (237). */
  businessMinutes: number;
  unassigned: boolean;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

/** Defensive parse of the RPC's rows; a malformed row is dropped. */
export function parseWaitingChats(raw: unknown): WaitingChat[] {
  if (!Array.isArray(raw)) return [];
  const out: WaitingChat[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Row;
    const id = str(row.conversation_id);
    const since = str(row.waiting_since);
    if (!id || !since || Number.isNaN(Date.parse(since))) continue;
    const assignee = str(row.assigned_agent_id);
    const minutes = Number(row.business_minutes);
    out.push({
      conversationId: id,
      contactId: str(row.contact_id),
      contactName: str(row.contact_name),
      contactPhone: str(row.contact_phone),
      assignedAgentId: assignee,
      waitingSince: since,
      businessMinutes:
        Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0,
      unassigned: row.unassigned === true || assignee === null,
    });
  }
  return out.sort(
    (a, b) =>
      Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
      a.conversationId.localeCompare(b.conversationId)
  );
}

/**
 * The waiting customers the caller can see; null on any error (a database
 * without migration 238 included), so the page keeps its last good rows
 * rather than claiming nobody waits. [] is a good, empty read.
 */
export async function loadWaitingChats(
  supabase: SupabaseClient,
  limit: number = WAITING_CHATS_LIMIT
): Promise<WaitingChat[] | null> {
  try {
    const { data, error } = await supabase.rpc('worklist_waiting_chats', {
      p_limit: limit,
    });
    return error ? null : parseWaitingChats(data);
  } catch {
    return null;
  }
}

export interface WaitingScope {
  mode: WorklistMode;
  /** The viewer's auth user id. */
  userId: string;
  /** All mode: one person's auth user id; '' or null for anyone. */
  assignedTo?: string | null;
  /** All mode, "My team": the people in it (wins over `assignedTo`). */
  team?: readonly string[] | null;
}

/**
 * The worklist's filter applied to the waiting chats. Own mode (agents,
 * viewers): the chats assigned to them, plus unassigned ones RLS shows
 * them. All mode (team leader and up): everything, or the chats
 * assigned to the chosen person or to someone in "My team". A bank
 * guest gets nothing.
 */
export function filterWaitingChats(
  rows: readonly WaitingChat[],
  scope: WaitingScope
): WaitingChat[] {
  if (scope.mode === 'none') return [];
  if (scope.mode === 'own') {
    return rows.filter(
      (r) => r.unassigned || r.assignedAgentId === scope.userId
    );
  }
  const people = scope.team
    ? new Set(scope.team)
    : scope.assignedTo
      ? new Set([scope.assignedTo])
      : null;
  return people
    ? rows.filter((r) => r.assignedAgentId && people.has(r.assignedAgentId))
    : [...rows];
}

/** The inbox deep link that opens the chat (as `hrefFor` builds it). */
export function waitingChatHref(conversationId: string): string {
  return `/inbox?c=${encodeURIComponent(conversationId)}`;
}

export interface WaitLabel {
  unit: DurationUnit;
  n: number;
}

/** Wall-clock time waited at `now`, in the unit a person would say. */
export function wallWait(row: WaitingChat, now: number): WaitLabel {
  return durationParts(now - Date.parse(row.waitingSince));
}

/** Business time waited; null when none of the wait was in business hours. */
export function businessWait(row: WaitingChat): WaitLabel | null {
  return row.businessMinutes > 0
    ? durationParts(row.businessMinutes * 60_000)
    : null;
}
