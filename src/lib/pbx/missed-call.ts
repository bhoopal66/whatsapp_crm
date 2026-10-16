/**
 * Who holds a missed call's task, and how repeat calls fold into it.
 * Pure: `process.ts` reads the rows and writes the task.
 *
 * The owner rule is the phone system's own, not `resolveTaskOwner`
 * (journeys share that one). That rule put every missed call on the
 * chat's agent, else the contact's `user_id`, which is whoever created
 * or imported the contact: on live the owner who imported every contact
 * got 31 call_missed bells and 27 task_due reminders for calls that rang
 * an agent's phone, or nobody's. A missed call belongs to the people it
 * rang; the contact's creator is never a fallback.
 */

export interface MissedCallOwnerInput {
  /** Who the call rang, first rung first (calls.meta.rang_user_ids). */
  rang: readonly string[];
  /** Live task holders of the workspace among `rang` and the chat's agent. */
  holders: ReadonlySet<string>;
  /** The conversation's assigned_agent_id. */
  assignedAgentId: string | null;
  /** The contact's user_id (its creator or importer). */
  contactOwnerId: string | null;
}

/**
 * The person the call rang who can hold a task: the chat's agent or the
 * contact's owner when the call rang them, else the first rung. A call
 * that rang no holder goes to the chat's agent, else to nobody (the
 * unassigned queue admins see, and no bell).
 */
export function missedCallOwner(input: MissedCallOwnerInput): string | null {
  const rung = input.rang.filter((u) => input.holders.has(u));
  if (rung.length) {
    for (const preferred of [input.assignedAgentId, input.contactOwnerId]) {
      if (preferred && rung.includes(preferred)) return preferred;
    }
    return rung[0];
  }
  const agent = input.assignedAgentId;
  return agent && input.holders.has(agent) ? agent : null;
}

/**
 * The calls a missed-call task already carries: `meta.call_ids`, else
 * (a task opened before calls were folded) its one `meta.call_id`.
 */
export function foldedCallIds(meta: unknown): string[] {
  if (typeof meta !== 'object' || meta === null) return [];
  const m = meta as Record<string, unknown>;
  if (Array.isArray(m.call_ids)) {
    return m.call_ids.filter((c): c is string => typeof c === 'string');
  }
  return typeof m.call_id === 'string' ? [m.call_id] : [];
}

/**
 * The task's note: "Missed call (no answer) on 9714…." for one call,
 * "3 missed calls, the latest (busy) on 9714…." once repeats fold in.
 */
export function missedCallNote(input: {
  count: number;
  status: string;
  didNumber: string | null;
  hint: string | null;
}): string {
  const head =
    input.count > 1 ? `${input.count} missed calls, the latest` : 'Missed call';
  const on = input.didNumber ? ` on ${input.didNumber}` : '';
  const hint = input.hint ? ` ${input.hint}` : '';
  return `${head} (${input.status.toLowerCase()})${on}.${hint}`;
}
