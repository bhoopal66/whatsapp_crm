// ============================================================
// Account role helpers — pure, unit-testable, no I/O.
//
// Mirrors the `account_role_enum` Postgres type from migration
// 017_account_sharing.sql. The hierarchy is intentionally a flat
// ordinal (owner=4 … viewer=1) — it matches the same CASE
// expression the `is_account_member(account_id, min_role)` SQL
// helper uses, so server-side TypeScript guards and database-side
// RLS speak the same language.
//
// Predicates (`canManageMembers`, `canEditSettings`, …) are the
// single source of truth for "what can this role do?" — both
// API route guards and UI gates should call them rather than
// open-coding their own role checks. That keeps role-policy
// changes a one-file diff.
// ============================================================

export type AccountRole =
  | "owner"
  | "admin"
  | "team_leader"
  | "agent"
  | "viewer";

/** Ordered list of every valid role, lowest privilege first. */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  "viewer",
  "agent",
  "team_leader",
  "admin",
  "owner",
] as const;

/**
 * Numeric rank of a role. Higher = more privileged. Mirrors the
 * CASE expression in `is_account_member` so JS/SQL stay aligned.
 */
export function roleRank(role: AccountRole): number {
  switch (role) {
    case "owner":
      return 5;
    case "admin":
      return 4;
    // Between agent and admin: runs a team's work, configures nothing
    // account-wide. Inserting a rung shifts the numbers above it; only
    // the relative order is meaningful, and `is_account_member`
    // compares the same ladder against itself on both sides.
    case "team_leader":
      return 3;
    case "agent":
      return 2;
    case "viewer":
      return 1;
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
    typeof value === "string" &&
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

/** Owner / admin: invite, remove, change roles. */
export function canManageMembers(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}

/**
 * Owner / admin: edit account-wide settings (WhatsApp config,
 * message templates, pipelines, tags, custom fields, account
 * name). Excludes per-user settings like avatar or own password.
 */
export function canEditSettings(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}

/**
 * Owner / admin / agent: write operational data — send messages,
 * create contacts, move deals, run broadcasts, edit automations.
 * Viewers are read-only.
 */
export function canSendMessages(role: AccountRole): boolean {
  return hasMinRole(role, "agent");
}

/**
 * Viewer: read-only across everything. Provided as a positive
 * predicate so UI gates read naturally (`if (canViewOnly(role))`
 * shows the "Read-only" tooltip without inverting `canSendMessages`).
 */
export function canViewOnly(role: AccountRole): boolean {
  return role === "viewer";
}

/** Owner only: irreversible destructive operations. */
export function canDeleteAccount(role: AccountRole): boolean {
  return role === "owner";
}

/** Owner only: hand the account to another member. */
export function canTransferOwnership(role: AccountRole): boolean {
  return role === "owner";
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
  return hasMinRole(role, "team_leader");
}

/** Admin and up: create teams, staff them, appoint their leaders. */
export function canManageTeams(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}
