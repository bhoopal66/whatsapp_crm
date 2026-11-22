// ============================================================
// Where a person lands after signing in (Track B item 8). Pure.
//
// Agents and team leaders start on My worklist, owners and admins on
// the dashboard. A viewer keeps the dashboard and a bank guest team
// chat, as before. The role is the one in the ACTIVE workspace (one
// login holds a profile per workspace, migration 083); an unknown role
// (no profile yet) is the dashboard, whose shell sorts it out.
//
// Only the post-login and `/` redirects ask this (`src/app/page.tsx`):
// an explicit deep link (`/login?next=…`, or any URL typed in) always
// wins over it, and the sidebar's logo keeps `workspaceHomePath`.
// ============================================================

import { GUEST_HOME_PATH } from './my-workspaces';
import {
  canManageMembers,
  hasMinRole,
  isBankGuest,
  type AccountRole,
} from './roles';

export type LandingPath = '/dashboard' | '/worklist' | typeof GUEST_HOME_PATH;

export function landingPathForRole(
  role: AccountRole | null | undefined
): LandingPath {
  if (!role) return '/dashboard';
  if (isBankGuest(role)) return GUEST_HOME_PATH;
  // Owner / admin run the workspace: the overview is theirs.
  if (canManageMembers(role)) return '/dashboard';
  // Agent and team leader work items one by one.
  if (hasMinRole(role, 'agent')) return '/worklist';
  return '/dashboard';
}
