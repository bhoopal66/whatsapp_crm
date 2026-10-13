// ============================================================
// The caller's workspaces, as the client sees them (migration 083).
//
// A workspace is an account. A person has one `profiles` row per
// workspace they belong to, each with its own role and deactivation,
// and exactly one row marked `is_active`: the workspace the whole app
// (and every RLS policy, through `current_account_id()`) is working in.
//
// The list comes from `my_workspaces()`, which is SECURITY DEFINER
// because a bank guest cannot read `accounts` through RLS. Its rows are
// snake_case; `Workspace` is camelCase so it matches the REST shape of
// `GET /api/workspaces` and one type serves either source.
//
// Pure: no I/O, so it is tested without a database or a DOM.
// ============================================================

import { isAccountRole, isBankGuest, type AccountRole } from './roles';

export interface Workspace {
  accountId: string;
  name: string;
  /** Up to four letters or digits ("TC"); null on an unnamed row. */
  shortName: string | null;
  /** Null when the database names a role this build does not know. */
  role: AccountRole | null;
  /** The workspace the person is working in. Exactly one per person. */
  isActive: boolean;
  /** This membership was deactivated by an admin of that workspace. */
  deactivated: boolean;
  /**
   * The workspace is archived (migration 105): nobody can enter it until
   * an owner restores it. Listed to its owners only, last.
   */
  archived: boolean;
}

/** One row of `my_workspaces()`. */
interface MyWorkspacesRow {
  account_id?: unknown;
  name?: unknown;
  short_name?: unknown;
  role?: unknown;
  is_active?: unknown;
  deactivated?: unknown;
  archived?: unknown;
}

/**
 * Narrow `my_workspaces()` rows into `Workspace`s, in the order the
 * function returns them (active first, then by name). Anything that is
 * not a list — an error body, a database without 083 — reads as no
 * workspaces, and a row without an account id is dropped.
 */
export function parseMyWorkspaces(rows: unknown): Workspace[] {
  if (!Array.isArray(rows)) return [];
  const out: Workspace[] = [];
  for (const raw of rows as MyWorkspacesRow[]) {
    if (!raw || typeof raw.account_id !== 'string' || !raw.account_id) {
      continue;
    }
    out.push({
      accountId: raw.account_id,
      name: typeof raw.name === 'string' ? raw.name : '',
      shortName:
        typeof raw.short_name === 'string' && raw.short_name.trim()
          ? raw.short_name
          : null,
      role: isAccountRole(raw.role) ? raw.role : null,
      isActive: raw.is_active === true,
      deactivated: raw.deactivated === true,
      archived: raw.archived === true,
    });
  }
  return out;
}

/**
 * Where to go when the active membership has been deactivated: the
 * first other workspace that is still open to the person, in the list's
 * order. An archived workspace is not open: switch_account refuses it.
 * Null when every membership is deactivated, and only then is
 * signing out the right answer — signing out someone who still has a
 * working membership lands them back on the deactivated one at their
 * next sign-in, and out again.
 */
export function fallbackWorkspace(
  workspaces: readonly Workspace[],
  deactivatedAccountId: string | null
): Workspace | null {
  return (
    workspaces.find(
      (w) =>
        !w.deactivated && !w.archived && w.accountId !== deactivatedAccountId
    ) ?? null
  );
}

/** The landing page of a workspace for someone holding `role` there. */
export function workspaceHomePath(
  role: AccountRole | null | undefined
): '/chat' | '/dashboard' {
  return isBankGuest(role) ? GUEST_HOME_PATH : '/dashboard';
}

/** A bank guest's only screen: team chat. */
export const GUEST_HOME_PATH = '/chat';

/** Is `pathname` part of what a bank guest may open (/chat and below)? */
export function isGuestPath(pathname: string): boolean {
  return (
    pathname === GUEST_HOME_PATH || pathname.startsWith(`${GUEST_HOME_PATH}/`)
  );
}

/**
 * Where the dashboard shell must send this person, or null to stay.
 * A bank guest is kept on /chat; everyone else, and anyone whose role
 * is still loading (null), stays where they are. This is UX, not access
 * control: RLS already gives a guest none of the other screens' data.
 */
export function guestRedirectPath(
  role: AccountRole | null | undefined,
  pathname: string
): string | null {
  return isBankGuest(role) && !isGuestPath(pathname) ? GUEST_HOME_PATH : null;
}

/** Stands in for this origin when a path is parsed; never fetched. */
const PATH_BASE = 'https://app.invalid';

/**
 * `next` when it is a path inside this app, else null. Only a plain
 * absolute path on this origin passes ("/inbox?c=…"): a scheme or host
 * ("https://evil", "javascript:"), a protocol-relative "//evil", a
 * backslash ("/\evil", which browsers read as "//evil") or any control
 * character or space (browsers drop tabs and newlines, so "/\t/evil"
 * would become "//evil") is refused, so a crafted value can never be an
 * open redirect.
 */
export function inAppPath(next: unknown): string | null {
  if (typeof next !== 'string' || !next.startsWith('/')) return null;
  if (next.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(next)) {
    return null;
  }
  try {
    const url = new URL(next, PATH_BASE);
    if (url.origin !== PATH_BASE) return null;
    // The normalised path, never the input: dot segments resolve here
    // ("/.//evil", "/%2e//evil" become "//evil"), and a value that is
    // only protocol-relative once normalised must not pass either.
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path.startsWith('//') ? null : path;
  } catch {
    return null;
  }
}

/**
 * Where entering a workspace as `role` lands: `next` when it is an
 * in-app path (`inAppPath`) that role may open, else the workspace's
 * home. A bank guest's `next` still has to be team chat, as
 * `guestRedirectPath` would otherwise bounce them there anyway.
 */
export function workspaceEntryPath(
  role: AccountRole | null | undefined,
  next?: unknown
): string {
  const path = inAppPath(next);
  if (!path) return workspaceHomePath(role);
  const { pathname } = new URL(path, PATH_BASE);
  return guestRedirectPath(role, pathname) ?? path;
}
