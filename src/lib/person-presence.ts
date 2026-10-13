// ============================================================
// A person's presence dot: the phone over the app (module 015 §7.7).
// Pure, no I/O; see person-presence.test.ts.
//
// Two sources:
//   - the app (member_presence, migration 024; lib/presence.ts):
//     online / away / offline, offline derived from a stale heartbeat;
//   - the phone (pbx_presence, migration 089; presenceView in
//     lib/pbx/calls.ts): Yeastar's per-extension call state (30008) and
//     the status the person chose (30009). A row exists only for an
//     extension with presence monitoring on, and carries the extension's
//     current person (process.ts and migration 101's mapping trigger).
//     Yeastar sends both only when they change, so the chosen status
//     holds until the next one; a call state lapses after
//     PRESENCE_STALE_MS unless the PBX cron refreshes it (101).
//
// Precedence, first match wins:
//   1. on a call (ringing or busy)       → on_call  red
//   2. Do not disturb                    → dnd      grey with a line
//   3. away, lunch or business trip      → away     the dot's away colour
//   4. off work                          → off_work grey
//   5. otherwise the app                 → online / away / offline
// The phone's 'available' falls through to the app: it is Yeastar's
// default status and says nothing about whether the person is at work.
// A lapsed call state shows the chosen status underneath. With no PBX, or for
// a person without a monitored extension, every dot takes step 5 and
// reads exactly as it did before the phone was wired in.
// ============================================================

import type { PresenceRow, PresenceView, UserPresence } from './pbx/calls';
import type { PresenceStatus } from './presence';

/** The app's three states plus what only the phone can say. */
export type PersonPresence = PresenceStatus | 'on_call' | 'dnd' | 'off_work';

export function personPresence(
  phone: PresenceView | null | undefined,
  app: PresenceStatus | null | undefined
): PersonPresence {
  switch (phone) {
    case 'on_call':
    case 'dnd':
    case 'away':
    case 'off_work':
      return phone;
  }
  return app ?? 'offline';
}

/** The message key for a state (`Presence.*`, `CustomerTimeline.presence.*`). */
export const PERSON_PRESENCE_KEY = {
  online: 'available',
  on_call: 'onCall',
  dnd: 'dnd',
  away: 'away',
  off_work: 'offWork',
  offline: 'offline',
} as const satisfies Record<PersonPresence, string>;

/**
 * A person's state from the two live sources: the phone rows by user id
 * (usePhonePresence, lower-cased keys) and the app's derived presence.
 */
export function presenceOf(
  userId: string,
  phone: Readonly<Record<string, UserPresence>>,
  app: (userId: string) => PresenceStatus
): PersonPresence {
  return personPresence(phone[userId.toLowerCase()]?.state, app(userId));
}

/** Liveliest first: someone reachable now, then someone busy, then gone. */
const LIVELINESS: readonly PersonPresence[] = [
  'online',
  'on_call',
  'dnd',
  'away',
  'off_work',
  'offline',
];

/** A group DM shows the liveliest of its other members. */
export function liveliest(states: readonly PersonPresence[]): PersonPresence {
  for (const s of LIVELINESS) if (states.includes(s)) return s;
  return 'offline';
}

// ---------- The live phone rows (hooks/use-phone-presence.ts) ----------

/** A pbx_presence row as the browser reads it; the key is (connection, extension). */
export interface PhonePresenceRow extends PresenceRow {
  connection_id: string;
}

export type PhoneRows = ReadonlyMap<string, PhonePresenceRow>;

const rowKey = (r: { connection_id?: unknown; extension?: unknown }) =>
  typeof r.connection_id === 'string' && typeof r.extension === 'string'
    ? `${r.connection_id}:${r.extension}`
    : null;

const newer = (a: PhonePresenceRow, b: PhonePresenceRow | undefined) =>
  !b || !(Date.parse(b.updated_at) > Date.parse(a.updated_at));

/**
 * One realtime change. INSERT and UPDATE carry the whole row. A DELETE
 * is left to the poll (mergePhoneSnapshot): the subscription filters on
 * account_id, which a delete's old record (its primary key) lacks, so
 * the feed does not deliver one.
 */
export function applyPhoneChange(
  rows: PhoneRows,
  change: {
    eventType: string;
    new?: Partial<PhonePresenceRow> | Record<string, unknown> | null;
  }
): PhoneRows {
  if (change.eventType !== 'INSERT' && change.eventType !== 'UPDATE')
    return rows;
  const row = change.new as PhonePresenceRow | null | undefined;
  const key = row ? rowKey(row) : null;
  if (!row || !key || typeof row.updated_at !== 'string') return rows;
  if (!newer(row, rows.get(key))) return rows;
  const next = new Map(rows);
  next.set(key, row);
  return next;
}

/**
 * A fresh read of the workspace's rows: it decides which rows exist (a
 * delete or a remap the realtime feed never delivered drops out here),
 * while a live event newer than the read keeps its row's content.
 */
export function mergePhoneSnapshot(
  prev: PhoneRows,
  snapshot: readonly PhonePresenceRow[]
): PhoneRows {
  const next = new Map<string, PhonePresenceRow>();
  for (const row of snapshot) {
    const key = rowKey(row);
    if (!key) continue;
    const live = prev.get(key);
    next.set(key, live && !newer(row, live) ? live : row);
  }
  return next;
}

/** Same people in the same states: nothing for a dot to redraw. */
export function samePhonePresence(
  a: Readonly<Record<string, UserPresence>>,
  b: Readonly<Record<string, UserPresence>>
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k]?.state === a[k].state);
}

/**
 * Whether to watch the phone at all: not in a workspace the extensions
 * read (pbx_extensions_select, the active account's) says has no PBX.
 * A failed read watches anyway, as it did before the check.
 */
export function workspaceHasPhones(read: {
  count: number | null;
  error: unknown;
}): boolean {
  return !!read.error || (read.count ?? 0) > 0;
}
