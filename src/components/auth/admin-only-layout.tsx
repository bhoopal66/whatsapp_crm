import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { getCurrentAccount } from '@/lib/auth/account';
import { AuthUnavailableError } from '@/lib/auth/auth-unavailable';
import { GUEST_HOME_PATH } from '@/lib/auth/my-workspaces';
import {
  canEditSettings,
  canLeadTeam,
  canManageReportAccess,
  canSendMessages,
  isBankGuest,
} from '@/lib/auth/roles';
import { parseReportKeys, type ReportKey } from '@/lib/reports/access';

/**
 * The auth service or the profile could not be read: not a sign-out, so
 * never the redirect to /login. Rethrown, it reaches the error boundary
 * (src/app/error.tsx, with its retry) and nothing is rendered.
 */
function rethrowUnavailable(err: unknown): void {
  if (err instanceof AuthUnavailableError) throw err;
}

/**
 * Server-side gate for the workspace-configuration screens —
 * Broadcasts, Automations, Flows, AI Agents, Compass and OpenDesk.
 * (Pipelines is everyone's since migration 080 and has no guard.)
 *
 * Those screens shape how the whole account operates, so they are
 * admin+ only. The sidebar already hides them from agents and viewers,
 * but hiding a link is not access control: the URL is still typeable,
 * still bookmarkable, and still in the browser history of anyone who
 * was an admin yesterday. This runs on the server, before the page
 * renders, so the answer does not depend on what the client believes
 * its role to be. The browser's router may hold the answer for up to
 * five minutes (the sidebar fully prefetches these rows; see
 * `staleTimes` in next.config.ts), which is why RLS, not this, is what
 * keeps the data from a demoted user.
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
  } catch (err) {
    rethrowUnavailable(err);
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
export async function TeamLeaderOnlyLayout({
  children,
}: {
  children: ReactNode;
}) {
  let signedIn = true;
  let allowed = false;

  try {
    const ctx = await getCurrentAccount();
    allowed = canLeadTeam(ctx.role);
  } catch (err) {
    rethrowUnavailable(err);
    signedIn = false;
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect('/dashboard');

  return <>{children}</>;
}

/**
 * Server-side gate for Team call recordings: team leader and above, as
 * {@link TeamLeaderOnlyLayout}, plus anyone an owner or admin allowed to
 * review every call (`profiles.may_review_all_calls`, migration 198),
 * which `pbx_sees_all_calls()` answers as the caller. Without 198 the
 * function is missing, the call errors and the role rule alone decides.
 * Same shape as {@link AdminOnlyLayout}, redirects outside the try.
 */
export async function CallReviewerLayout({
  children,
}: {
  children: ReactNode;
}) {
  let signedIn = true;
  let allowed = false;

  let ctx: Awaited<ReturnType<typeof getCurrentAccount>> | null = null;
  try {
    ctx = await getCurrentAccount();
    allowed = canLeadTeam(ctx.role);
  } catch (err) {
    rethrowUnavailable(err);
    signedIn = false;
  }
  if (ctx && !allowed && !isBankGuest(ctx.role)) {
    try {
      const { data, error } = await ctx.supabase.rpc('pbx_sees_all_calls');
      allowed = !error && data === true;
    } catch {
      // A failed check is a refusal, never a sign-out.
    }
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
  } catch (err) {
    rethrowUnavailable(err);
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
  } catch (err) {
    rethrowUnavailable(err);
    signedIn = false;
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect(GUEST_HOME_PATH);

  return <>{children}</>;
}

/**
 * Server-side gate for the sales areas (`RESTRICTED_PATHS` in
 * `lib/auth/departments.ts`): a person whose department is restricted
 * (migration 192, HR by default) is sent to their own inbox, whatever
 * their role. Owners and admins are never restricted. Composed inside
 * each area's role guard, which still decides by role. Same shape as
 * {@link AdminOnlyLayout}, redirects outside the try.
 */
export async function SalesOnlyLayout({ children }: { children: ReactNode }) {
  let signedIn = true;
  let allowed = false;

  try {
    const ctx = await getCurrentAccount();
    allowed = !ctx.salesRestricted;
  } catch (err) {
    rethrowUnavailable(err);
    signedIn = false;
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect('/inbox');

  return <>{children}</>;
}

/**
 * Server-side gate for the HR inbox and its screens (migration 200):
 * owners and admins, plus anyone on an HR team (`hr_team_members`),
 * which `hr_my_roles()` answers as the caller. Membership grants no
 * chat visibility: what the list shows is still decided by RLS. Without
 * 200 the function is missing, the call errors and only admins pass
 * (fail closed). Same shape as {@link AdminOnlyLayout}, redirects
 * outside the try.
 */
export async function HrAccessLayout({ children }: { children: ReactNode }) {
  let signedIn = true;
  let allowed = false;

  let ctx: Awaited<ReturnType<typeof getCurrentAccount>> | null = null;
  try {
    ctx = await getCurrentAccount();
    allowed = canEditSettings(ctx.role);
  } catch (err) {
    rethrowUnavailable(err);
    signedIn = false;
  }
  if (ctx && !allowed && !isBankGuest(ctx.role)) {
    try {
      const { data, error } = await ctx.supabase.rpc('hr_my_roles');
      const roles = data as { recruiter?: unknown; dept?: unknown } | null;
      allowed =
        !error && !!roles && (roles.recruiter != null || roles.dept != null);
    } catch {
      // A failed check is a refusal, never a sign-out.
    }
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect('/dashboard');

  return <>{children}</>;
}

/**
 * Server-side gate for a per-person report (migration 255; today the
 * chat tag report, `report="chat_tags"`): the owner, plus anyone the
 * owner granted it, which `report_my_access()` answers as the caller (a
 * grant counts only while the person is live staff). Admins have no
 * standing access. A failed check is a refusal (fail closed), and a
 * bank guest is never asked. Same shape as {@link AdminOnlyLayout},
 * redirects outside the try.
 */
export async function ReportAccessLayout({
  report,
  children,
}: {
  report: ReportKey;
  children: ReactNode;
}) {
  let signedIn = true;
  let allowed = false;

  let ctx: Awaited<ReturnType<typeof getCurrentAccount>> | null = null;
  try {
    ctx = await getCurrentAccount();
    allowed = canManageReportAccess(ctx.role);
  } catch (err) {
    rethrowUnavailable(err);
    signedIn = false;
  }
  if (ctx && !allowed && !isBankGuest(ctx.role)) {
    try {
      const { data, error } = await ctx.supabase.rpc('report_my_access');
      allowed = !error && parseReportKeys(data).includes(report);
    } catch {
      // A failed check is a refusal, never a sign-out.
    }
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect('/dashboard');

  return <>{children}</>;
}

/**
 * Server-side gate for the Reports landing and everything under
 * /reports: admin and up (the funnel is theirs), or anyone holding a
 * report key (`report_my_access()`). Each report adds its own guard in
 * its folder (the funnel {@link AdminOnlyLayout}, the chat tag report
 * {@link ReportAccessLayout}). Fails closed; a bank guest is never
 * asked. Same shape as {@link AdminOnlyLayout}, redirects outside the
 * try.
 */
export async function ReportsLandingLayout({
  children,
}: {
  children: ReactNode;
}) {
  let signedIn = true;
  let allowed = false;

  let ctx: Awaited<ReturnType<typeof getCurrentAccount>> | null = null;
  try {
    ctx = await getCurrentAccount();
    allowed = canEditSettings(ctx.role);
  } catch (err) {
    rethrowUnavailable(err);
    signedIn = false;
  }
  if (ctx && !allowed && !isBankGuest(ctx.role)) {
    try {
      const { data, error } = await ctx.supabase.rpc('report_my_access');
      allowed = !error && parseReportKeys(data).length > 0;
    } catch {
      // A failed check is a refusal, never a sign-out.
    }
  }

  if (!signedIn) redirect('/login');
  if (!allowed) redirect('/dashboard');

  return <>{children}</>;
}
