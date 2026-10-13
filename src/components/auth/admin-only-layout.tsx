import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { getCurrentAccount } from '@/lib/auth/account';
import { GUEST_HOME_PATH } from '@/lib/auth/my-workspaces';
import {
  canEditSettings,
  canLeadTeam,
  canSendMessages,
  isBankGuest,
} from '@/lib/auth/roles';

/**
 * Server-side gate for the workspace-configuration screens —
 * Pipelines, Broadcasts, Automations, Flows and AI Agents.
 *
 * Those screens shape how the whole account operates, so they are
 * admin+ only. The sidebar already hides them from agents and viewers,
 * but hiding a link is not access control: the URL is still typeable,
 * still bookmarkable, and still in the browser history of anyone who
 * was an admin yesterday. This runs on the server, before the page
 * renders, so the answer does not depend on what the client believes
 * its role to be.
 *
 * `canEditSettings` rather than a bare role comparison, so this moves
 * in lockstep with the rest of the admin surface if the policy ever
 * changes — the predicate is the single source of truth.
 *
 * Note the redirects sit OUTSIDE the try. `redirect()` signals itself
 * by throwing, so calling it inside would have the catch swallow the
 * redirect and fall through to rendering the page — the exact opposite
 * of what this component is for.
 */
export async function AdminOnlyLayout({ children }: { children: ReactNode }) {
  let signedIn = true;
  let allowed = false;

  try {
    const ctx = await getCurrentAccount();
    allowed = canEditSettings(ctx.role);
  } catch {
    // getCurrentAccount throws for a signed-out caller and for a user
    // with no account/role row. Either way they cannot be an admin.
    signedIn = false;
  }

  if (!signedIn) redirect('/login');
  // Somewhere they can definitely go, rather than a dead end.
  if (!allowed) redirect('/dashboard');

  return <>{children}</>;
}

/**
 * Server-side gate for the team views — Team inbox and Team contacts.
 *
 * Team leader and above. Admins pass because they outrank a leader and
 * already see the whole account; what each of them actually gets back
 * is decided by RLS (`leads_teammate`, migration 044), not here.
 *
 * Same shape as {@link AdminOnlyLayout}, including keeping the
 * redirects outside the try — `redirect()` throws to do its job.
 */
export async function TeamLeaderOnlyLayout({ children }: { children: ReactNode }) {
  let signedIn = true;
  let allowed = false;

  try {
    const ctx = await getCurrentAccount();
    allowed = canLeadTeam(ctx.role);
  } catch {
    signedIn = false;
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect('/dashboard');

  return <>{children}</>;
}

/**
 * Server-side gate for the screens where people act on customers
 * (Journeys): agent and above, so never a viewer or a bank guest.
 * Same shape as {@link AdminOnlyLayout}, redirects outside the try.
 */
export async function AgentOnlyLayout({ children }: { children: ReactNode }) {
  let signedIn = true;
  let allowed = false;

  try {
    const ctx = await getCurrentAccount();
    allowed = canSendMessages(ctx.role);
  } catch {
    signedIn = false;
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect('/dashboard');

  return <>{children}</>;
}

/**
 * Server-side gate for the screens every staff role may read (Calls,
 * module 015): viewer and above, never a bank guest, who is sent to team
 * chat, their one screen. Their API routes refuse a guest already; this
 * keeps the page itself from them. Same shape as {@link AdminOnlyLayout},
 * redirects outside the try.
 */
export async function StaffOnlyLayout({ children }: { children: ReactNode }) {
  let signedIn = true;
  let allowed = false;

  try {
    const ctx = await getCurrentAccount();
    allowed = !isBankGuest(ctx.role);
  } catch {
    signedIn = false;
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect(GUEST_HOME_PATH);

  return <>{children}</>;
}
