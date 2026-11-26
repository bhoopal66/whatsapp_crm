// ============================================================
// Noticing, in a tab that stays open for days, that the person's
// workspace, role or department changed somewhere else.
//
// It decides what people see, so a doubtful answer is never acted on: a
// failed read, an empty one (a request that went out with the anon key
// reads as empty too), no active row, or a role or department this
// build does not know.
//
// Pure: no I/O, so it is tested without a database or a DOM.
// ============================================================

import { isDepartment, type Department } from './departments';
import { isAccountRole, type AccountRole } from './roles';

/** A tab that is shown again asks at most this often. */
export const PROFILE_CHECK_EVERY_MS = 120_000;

/**
 * Whether to read the profile now: when the tab is shown, unless it asked
 * a moment ago, and whenever the session's token was refreshed (hourly).
 */
export function profileCheckDue(state: {
  trigger: 'visibility' | 'token';
  visible: boolean;
  lastCheckAt: number | null;
  now: number;
}): boolean {
  if (state.trigger === 'token') return true;
  if (!state.visible) return false;
  return (
    state.lastCheckAt === null ||
    state.now - state.lastCheckAt >= PROFILE_CHECK_EVERY_MS
  );
}

/** The columns of a `profiles` row the watch reads. */
export interface WatchedRow {
  account_id: string | null;
  account_role: string | null;
  is_active?: boolean | null;
  deactivated_at?: string | null;
  department?: string | null;
}

/**
 * The person's active row, or null when the answer does not say. Not
 * `pickActiveProfile`: its fallback to the first row is a guess, and a
 * guess here would tell someone they switched workspace.
 */
export function watchedActiveRow<T extends WatchedRow>(answer: {
  data: readonly T[] | null;
  error: unknown;
}): T | null {
  if (answer.error) return null;
  const active = (answer.data ?? []).filter((row) => row.is_active === true);
  return active.length === 1 && active[0].account_id ? active[0] : null;
}

export type ProfileChange =
  | { kind: 'none' }
  /** Another workspace is active now; the role held there, if known. */
  | { kind: 'switched'; role: AccountRole | null }
  /** The workspace this tab shows was deactivated for the person. */
  | { kind: 'deactivated' }
  | { kind: 'update'; role: AccountRole; department: Department };

/** What a tab says in its bar; the other changes need no words. */
export type ProfileNotice = Extract<
  ProfileChange,
  { kind: 'switched' | 'deactivated' }
>;

/** What changed between what this tab shows and the active row. */
export function compareProfile(
  shown: {
    account_id: string;
    account_role: AccountRole;
    department: Department;
  },
  row: WatchedRow
): ProfileChange {
  const role = isAccountRole(row.account_role) ? row.account_role : null;
  if (row.account_id !== shown.account_id) return { kind: 'switched', role };
  if (row.deactivated_at) return { kind: 'deactivated' };
  // A row without the column predates migration 192.
  const department =
    row.department === undefined ? shown.department : row.department;
  if (!role || !isDepartment(department)) return { kind: 'none' };
  return role === shown.account_role && department === shown.department
    ? { kind: 'none' }
    : { kind: 'update', role, department };
}
