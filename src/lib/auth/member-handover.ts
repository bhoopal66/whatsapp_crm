// Handing a person's work to a colleague (migration 266): the shapes of
// /api/account/members/[userId]/handover and /api/account/members/left-work,
// pure, for the routes and the screens alike.

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
