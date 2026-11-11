// ============================================================
// Departments (migration 192) — pure, shared by server and client.
//
// `profiles.department` says which part of the company a person works
// in. An account may mark a department "restricted" (`account_departments`,
// else the built-in default below, mirrored by SQL
// `department_restricted()`): its people work only their own chats and
// cannot open the sales areas listed in RESTRICTED_PATHS, whatever their
// role. Owners and admins are never restricted; their department only
// affects inbox routing.
// ============================================================

import type { AccountRole } from './roles';

export const DEPARTMENTS = ['sales', 'hr', 'it', 'accounts'] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Column default, and what a database without migration 192 means. */
export const DEFAULT_DEPARTMENT: Department = 'sales';

/**
 * Built-in restriction per department, used when an account has no
 * `account_departments` row for it. TODO(192): pin to the migration's
 * `department_restricted()` defaults with a test that reads the SQL
 * once 192 lands (it was written in parallel and is not on this branch).
 */
export const DEPARTMENT_DEFAULTS: Record<Department, { restricted: boolean }> =
  {
    sales: { restricted: false },
    hr: { restricted: true },
    it: { restricted: false },
    accounts: { restricted: false },
  };

export function isDepartment(value: unknown): value is Department {
  return (
    typeof value === 'string' &&
    (DEPARTMENTS as readonly string[]).includes(value)
  );
}

/** A stored value, narrowed: NULL, missing or unknown reads as sales. */
export function toDepartment(value: unknown): Department {
  return isDepartment(value) ? value : DEFAULT_DEPARTMENT;
}

/**
 * Whether this person is kept out of the sales areas. `restricted` is
 * the account's answer for their department (`department_restricted()`);
 * owners and admins are exempt whatever it says.
 */
export function isSalesRestricted({
  role,
  restricted,
}: {
  role: AccountRole | null;
  department?: Department | null;
  restricted: boolean;
}): boolean {
  if (!role) return false;
  if (role === 'owner' || role === 'admin') return false;
  return restricted;
}

/**
 * Screens a restricted person may not open, as path prefixes. The
 * customer page `/contacts/[id]` stays open: only the list itself is
 * listed, matched exactly (see {@link isRestrictedPath}).
 */
export const RESTRICTED_PATHS = [
  '/pipelines',
  '/cases',
  '/banks',
  '/submission-groups',
  '/groups',
  '/broadcasts',
  '/automations',
  '/flows',
  '/journeys',
  '/agents',
  '/compass',
  '/opendesk',
  '/team-inbox',
  '/team-contacts',
] as const;

/** Paths restricted only as themselves, not their children. */
export const RESTRICTED_EXACT_PATHS = ['/contacts'] as const;

/** Settings sections a restricted person does not get. */
export const RESTRICTED_SETTINGS_SECTIONS = ['templates', 'ai'] as const;

/** True if `pathname` (no query string) is a screen kept from them. */
export function isRestrictedPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  if ((RESTRICTED_EXACT_PATHS as readonly string[]).includes(path)) return true;
  return RESTRICTED_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}
