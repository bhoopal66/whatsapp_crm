// ============================================================
// Where a person lands after signing in (Track B item 8). Pure.
//
// Agents and team leaders start on My worklist, owners and admins on
// the dashboard. A viewer keeps the dashboard and a bank guest team
// chat, as before. The role is the one in the ACTIVE workspace (one
// login holds a profile per workspace, migration 083); an unknown role
// (no profile yet) is the dashboard, whose shell sorts it out.
//
// The post-login and `/` redirects ask this (`src/app/page.tsx`): an
// explicit deep link (`/login?next=…`, or any URL typed in) always wins
// over it. The rule itself is `workspaceHomePath` (my-workspaces.ts), which
// the sidebar's logo and a workspace switch use too, so they agree.
// ============================================================

import { workspaceHomePath } from './my-workspaces';
import type { AccountRole } from './roles';

export type LandingPath = ReturnType<typeof workspaceHomePath>;

export function landingPathForRole(
  role: AccountRole | null | undefined
): LandingPath {
  return workspaceHomePath(role);
}
