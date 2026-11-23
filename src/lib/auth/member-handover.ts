// Handing a person's work to a colleague (migration 266): the shapes of
// /api/account/members/[userId]/handover and /api/account/members/left-work,
// pure, for the routes and the screens alike.

import type { AccountRole } from './roles';

export const HANDOVER_KINDS = ['chats', 'tasks', 'deals', 'contacts'] as const;
export type HandoverKind = (typeof HANDOVER_KINDS)[number];

export type WorkCounts = Record<HandoverKind, number>;

export interface LeftWork extends WorkCounts {
  userId: string;
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;

/** The RPCs' `{chats, tasks, deals, contacts}`; anything missing is 0. */
export function parseWorkCounts(value: unknown): WorkCounts {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    chats: count(v.chats),
    tasks: count(v.tasks),
    deals: count(v.deals),
    contacts: count(v.contacts),
  };
}

/** `members_left_work()` rows. */
export function parseLeftWork(value: unknown): LeftWork[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r: Record<string, unknown> | null) =>
    typeof r?.user_id === 'string'
      ? [{ userId: r.user_id, ...parseWorkCounts(r) }]
      : []
  );
}

/** A non-empty list of known kinds, once each; null for anything else. */
export function parseHandoverKinds(value: unknown): HandoverKind[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((k) => HANDOVER_KINDS.includes(k))) return null;
  return HANDOVER_KINDS.filter((k) => value.includes(k));
}

export const workTotal = (c: WorkCounts): number =>
  HANDOVER_KINDS.reduce((sum, k) => sum + c[k], 0);

/** The left-work route's rows by person; anything malformed is dropped. */
export function leftWorkByPerson(value: unknown): Map<string, WorkCounts> {
  const rows = (value as { members?: unknown } | null)?.members;
  const out = new Map<string, WorkCounts>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows as (Record<string, unknown> | null)[]) {
    if (typeof r?.userId !== 'string') continue;
    const counts = parseWorkCounts(r);
    if (workTotal(counts) > 0) out.set(r.userId, counts);
  }
  return out;
}

/** A person as the roster lists them, for the handover screen. */
export interface HandoverPerson {
  user_id: string;
  name: string;
  role: AccountRole;
  deactivated_at: string | null;
}

const RECEIVER_ROLES: readonly AccountRole[] = [
  'owner',
  'admin',
  'team_leader',
  'agent',
];

/** Who can be offered to take it over (266 decides), by name. */
export function handoverReceivers(
  people: readonly HandoverPerson[],
  fromId: string
): HandoverPerson[] {
  return people
    .filter(
      (p) =>
        p.user_id !== fromId &&
        !p.deactivated_at &&
        RECEIVER_ROLES.includes(p.role)
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
