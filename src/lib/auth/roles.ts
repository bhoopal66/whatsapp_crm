// ============================================================
// Account role helpers — pure, unit-testable, no I/O.
//
// Mirrors the `account_role_enum` Postgres type from migration
// 017_account_sharing.sql (plus `bank_guest`, 082). The hierarchy is
// intentionally a flat ordinal (owner=5 … viewer=1, bank_guest=0) —
// it matches the ladder in `is_account_member(account_id, min_role)`
// and `current_role_rank()` as rewritten by 083_workspaces.sql, so
// server-side TypeScript guards and database-side RLS speak the same
// language.
//
// Predicates (`canManageMembers`, `canEditSettings`, …) are the
// single source of truth for "what can this role do?" — both
// API route guards and UI gates should call them rather than
// open-coding their own role checks. That keeps role-policy
// changes a one-file diff.
// ============================================================

export type AccountRole =
  'owner' | 'admin' | 'team_leader' | 'agent' | 'viewer' | 'bank_guest';

/** Ordered list of every valid role, lowest privilege first. */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  'bank_guest',
  'viewer',
  'agent',
  'team_leader',
  'admin',
  'owner',
] as const;

/**
 * Roles an admin may give a person, highest first: every role but
 * `owner` (an account has exactly one, moved by `transfer_ownership`).
 * The create-login dialog, the invite dialog, the roster's inline role
 * change and the members API all offer exactly this list, so a role
 * can never be reachable one way and not another. `team_leader` is a
 * real role (migration 044), not derived from Teams: appointing a team
 * leader does not change anyone's role.
 */
export const ASSIGNABLE_ROLES = [
  'admin',
  'team_leader',
  'agent',
  'viewer',
] as const satisfies readonly AccountRole[];

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * The account's own people, lowest privilege first: every role but
 * `bank_guest`. A list of people who work the CRM — assignees, team
 * members, number allocations — offers only these.
 */
export const STAFF_ROLES = [
  'viewer',
  'agent',
  'team_leader',
  'admin',
  'owner',
] as const satisfies readonly AccountRole[];

/**
 * A partner bank's officer (migrations 082/083): a membership that
 * sees none of the inbox, contacts, deals or settings. Rank 0, below
 * viewer, so `hasMinRole` and every capability predicate below are
 * false for it; SQL gives the guest no `current_account_id()`, which
 * closes every account-scoped policy.
 */
export function isBankGuest(role: AccountRole | null | undefined): boolean {
  return role === 'bank_guest';
}

/**
 * Numeric rank of a role. Higher = more privileged. Mirrors the
 * CASE expression in `is_account_member` so JS/SQL stay aligned.
 */
export function roleRank(role: AccountRole): number {
  switch (role) {
    case 'owner':
      return 5;
    case 'admin':
      return 4;
    // Between agent and admin: runs a team's work, configures nothing
    // account-wide. Inserting a rung shifts the numbers above it; only
    // the relative order is meaningful, and `is_account_member`
    // compares the same ladder against itself on both sides.
    case 'team_leader':
      return 3;
    case 'agent':
      return 2;
    case 'viewer':
      return 1;
    // Below every staff role: never an `is_account_member` (083).
    case 'bank_guest':
      return 0;
  }
}

/**
 * True iff `role` is at least as privileged as `min`. Use this
 * for any "user has at least admin" / "at least agent" checks.
 */
export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/** Type-narrow an unknown string into a valid `AccountRole`. */
export function isAccountRole(value: unknown): value is AccountRole {
  return (
    typeof value === 'string' &&
    (ACCOUNT_ROLES as readonly string[]).includes(value)
  );
}

// ============================================================
// Capability predicates
//
// Every UI gate and API route guard should call one of these
// instead of comparing role strings inline. Adding a capability
// = one new predicate here + one call site change per consumer.
// ============================================================

/**
 * Owner / admin: the whole roster — change roles, deactivate, remove —
 * and add people with any role. Ownership moves only by transfer.
 */
export function canManageMembers(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/**
 * Team leader and up: add people to the workspace, by invite link or
 * by email (migration 099). Which roles is `canGrantRole`; changing a
 * role, deactivating and removing stay `canManageMembers`.
 */
export function canInviteMembers(role: AccountRole): boolean {
  return hasMinRole(role, 'team_leader');
}

/**
 * The roles a team leader may give: the people a leader runs. Mirrored
 * by `add_workspace_member` and the `account_invitations` leader
 * policies (099) — change one, change both.
 */
export const LEADER_GRANTABLE_ROLES = [
  'agent',
  'viewer',
] as const satisfies readonly AccountRole[];

/**
 * May a caller with `role` add someone as `target`? Owner / admin: any
 * role but owner (a bank guest included, which the add-member path
 * takes with a bank code). A team leader: only `LEADER_GRANTABLE_ROLES`
 * — never admin, team_leader, owner or bank_guest. Anyone else: none.
 */
export function canGrantRole(role: AccountRole, target: AccountRole): boolean {
  if (target === 'owner') return false;
  if (canManageMembers(role)) return true;
  return (
    canInviteMembers(role) &&
    (LEADER_GRANTABLE_ROLES as readonly AccountRole[]).includes(target)
  );
}

/** `roles` narrowed to those `role` may grant, order kept (for the
 *  role pickers in the add and invite dialogs). */
export function grantableRoles<R extends AccountRole>(
  role: AccountRole | null,
  roles: readonly R[]
): R[] {
  return role ? roles.filter((r) => canGrantRole(role, r)) : [];
}

/**
 * Owner / admin: edit account-wide settings (WhatsApp config,
 * message templates, pipelines, tags, custom fields, account
 * name). Excludes per-user settings like avatar or own password.
 */
export function canEditSettings(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/**
 * Owner / admin: place or lift a legal hold on a call recording
 * (pbx_set_recording_hold, migration 093). A hold keeps the audio past
 * the retention period and blocks the owner's erasure.
 */
export function canPlaceLegalHold(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/**
 * Owner / admin / agent: write operational data — send messages,
 * create contacts, move deals, run broadcasts, edit automations.
 * Viewers are read-only.
 */
export function canSendMessages(role: AccountRole): boolean {
  return hasMinRole(role, 'agent');
}

/**
 * Viewer: read-only across everything. Provided as a positive
 * predicate so UI gates read naturally (`if (canViewOnly(role))`
 * shows the "Read-only" tooltip without inverting `canSendMessages`).
 */
export function canViewOnly(role: AccountRole): boolean {
  return role === 'viewer';
}

/** Owner only: irreversible destructive operations. */
export function canDeleteAccount(role: AccountRole): boolean {
  return role === 'owner';
}

/** Owner only: hand the account to another member. */
export function canTransferOwnership(role: AccountRole): boolean {
  return role === 'owner';
}

/**
 * Team leader and up: sees the Team Inbox / Team Contacts views and
 * may move work between the people they lead.
 *
 * Admins pass this too — they outrank a leader and already see the
 * whole account — so the nav entries appear for them as well. Which
 * rows those views actually return is the database's decision
 * (`leads_teammate`, migration 044), not this predicate's.
 */
export function canLeadTeam(role: AccountRole): boolean {
  return hasMinRole(role, 'team_leader');
}

/** Admin and up: create teams, staff them, appoint their leaders. */
export function canManageTeams(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}
