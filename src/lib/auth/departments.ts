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

/** What one department's switches are in a workspace. */
export interface DepartmentSettings {
  own_inbox: boolean;
  restricted: boolean;
}

/**
 * Built-in switches per department, used when an account has no
 * `account_departments` row for it. Mirrors SQL
 * `department_own_inbox()` / `department_restricted()`: hr on/on, the
 * rest off/off; `departments.test.ts` reads migration 192 to pin it.
 */
export const DEPARTMENT_DEFAULTS: Record<Department, DepartmentSettings> = {
  sales: { own_inbox: false, restricted: false },
  hr: { own_inbox: true, restricted: true },
  it: { own_inbox: false, restricted: false },
  accounts: { own_inbox: false, restricted: false },
};

/**
 * Every department's switches: a saved `account_departments` row wins,
 * a missing (or malformed) one is the built-in default.
 */
export function mergeDepartmentSettings(
  rows: ReadonlyArray<{
    department?: unknown;
    own_inbox?: unknown;
    restricted?: unknown;
  }> | null
): Record<Department, DepartmentSettings> {
  const out = {} as Record<Department, DepartmentSettings>;
  for (const d of DEPARTMENTS) out[d] = { ...DEPARTMENT_DEFAULTS[d] };
  for (const row of rows ?? []) {
    if (!isDepartment(row.department)) continue;
    if (
      typeof row.own_inbox !== 'boolean' ||
      typeof row.restricted !== 'boolean'
    )
      continue;
    out[row.department] = {
      own_inbox: row.own_inbox,
      restricted: row.restricted,
    };
  }
  return out;
}

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
