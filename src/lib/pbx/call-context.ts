// Pure pieces of the in-call window's customer tabs (Previous calls,
// Open tasks), kept here so they can be tested without a DOM.

import type { TimelineCall } from './timeline';

/** A row of GET /api/pbx/calls, as the Previous calls list reads it. */
export interface HistoryCall extends TimelineCall {
  pbxCallId?: string | null;
  endedAt?: string | null;
}

/** How many earlier calls the list shows; it asks for one more. */
export const HISTORY_MAX = 10;

/**
 * The customer's earlier calls: the call in progress left out (matched
 * on the PBX's own id, the one a live call is known by), newest first
 * as the route returns them, at most `max`.
 */
export function earlierCalls<T extends HistoryCall>(
  calls: readonly T[],
  currentPbxCallId: string | null | undefined,
  max = HISTORY_MAX
): T[] {
  const current = currentPbxCallId?.trim() || null;
  return calls.filter((c) => !current || c.pbxCallId !== current).slice(0, max);
}

/** A call no one answered: what the row's icon and tone say. */
export const wasAnswered = (c: Pick<TimelineCall, 'status' | 'answeredAt'>) =>
  c.status === 'answered' || !!c.answeredAt;

/** A task due before `now` (an undated one never is). */
export function isOverdue(dueAt: string | null, now: number): boolean {
  if (!dueAt) return false;
  const at = Date.parse(dueAt);
  return Number.isFinite(at) && at < now;
}
