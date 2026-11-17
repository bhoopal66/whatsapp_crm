import { isRestrictedPath } from '@/lib/auth/departments';
import {
  Activity,
  Brain,
  Briefcase,
  Building2,
  ContactRound,
  GitBranch,
  Headset,
  Inbox,
  Landmark,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  MessagesSquare,
  Phone,
  Radio,
  Route,
  Settings,
  Users,
  UsersRound,
  FolderKanban,
  Video,
  CalendarDays,
  Workflow,
  Zap,
  type LucideIcon,
  AudioLines,
  IdCard,
  ListTodo,
  MessageSquareText,
  Rocket,
  SlidersHorizontal,
  UserCheck,
  UserSearch,
} from 'lucide-react';

import { hasMinRole, isBankGuest, type AccountRole } from '@/lib/auth/roles';
import { hasHrAccess } from '@/lib/hr/access';
import { hrInboxLinks } from '@/lib/hr/topic-ui';
import type { HrRoles } from '@/lib/hr/types';

/**
 * The sidebar's information architecture.
 *
 * Grouped by area of work, under small headings: first the staff's own
 * tools for working together, then the customer work in the order it
 * flows: the conversations, the customers and their deals, the cases
 * submitted to banks. After those come the higher roles' extra views:
 * Team for a team leader, then the admins' campaign, automation and
 * integration screens. Only Dashboard, the home row, sits above the
 * headings. A group is dropped when the role may open nothing in it, so
 * no role is shown a heading over nothing.
 */
export interface NavItem {
  href: string;
  /** Key in the `Sidebar` message namespace. */
  labelKey: string;
  icon: LucideIcon;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
  /**
   * Minimum role that may see this destination. Omitted means everyone
   * in the account. This hides the row; the route itself is guarded
   * server-side by its own layout (components/auth/admin-only-layout),
   * because a hidden link is not access control.
   */
  minRole?: AccountRole;
  /**
   * Shown to a bank guest (migrations 082/083) as well. Every other row
   * is the account's own people's only: a guest sees nothing of the
   * inbox, contacts, deals or settings, and the dashboard shell keeps a
   * guest on /chat whatever links exist. Reserved for the team-chat row.
   */
  guestVisible?: boolean;
  /**
   * Shown only where the phone system is in use (module 015): the person
   * has an extension, or the workspace has one (`callsSidebar`, the rule
   * the chat sidebar's CALLS rows follow). Until the sidebar knows, the
   * row is hidden, as a gated row is while the role loads.
   */
  needsPbx?: boolean;
  /**
   * Shown only while the workspace has the second brain switched on
   * (migration 194, Settings → Cases). Hidden until the sidebar knows,
   * like `needsPbx`; the API answers 403 `brain_disabled` either way.
   */
  needsBrain?: boolean;
  /**
   * Also shown, below `minRole`, to a person allowed to review every
   * call (`profiles.may_review_all_calls`, migration 198; `ctx.callReviewer`).
   * Only the minRole check is waived: `needsPbx` and a restricted
   * department still hide the row.
   */
  callReviewerVisible?: boolean;
  /**
   * An HR screen (migration 200): shown to owners and admins, and to
   * the HR roles (`hr_my_roles()`, `ctx.hrRoles`) the gate names, see
   * {@link hrGateOpen}. `minRole` is not read. The HR screens are not a
   * sales area, so a restricted department (HR people are one) keeps
   * them; each route's HrAccessLayout is the server-side guard.
   */
  hr?: HrNavGate;
  /**
   * The route's own layout guards it on the server (one of the
   * `*OnlyLayout` gates in components/auth/admin-only-layout). Reading
   * the session there makes the route dynamic, so the default `auto`
   * prefetch stops at the dashboard's loading boundary and the click
   * waits out a round trip; see {@link navPrefetch}.
   */
  guarded?: boolean;
}

/** What the sidebar knows beyond the role. */
export interface NavContext {
  /** A restricted department (192): sales-area rows are hidden. */
  salesRestricted?: boolean;
  /** This person can use the phone system (`callsSidebar(…).visible`). */
  pbx?: boolean;
  /** The workspace has the second brain on (`settings.brainEnabled`). */
  brain?: boolean;
  /** Allowed to review every call (migration 198, `reviewsAllCalls`). */
  callReviewer?: boolean;
  /** The person's HR roles (migration 200); null/absent: none known. */
  hrRoles?: HrRoles | null;
}

/**
 * Which HR roles open an HR row: `recruiter` / `dept` a role in that
 * inbox, `any` either, `hireFast` / `automatedMessages` what
 * `hrInboxLinks` offers (the pages' own rule).
 */
export type HrNavGate =
  'recruiter' | 'dept' | 'any' | 'hireFast' | 'automatedMessages';

/** Does `roles` open an HR row gated by `gate`? (Admins: always.) */
export function hrGateOpen(gate: HrNavGate, roles: HrRoles | null): boolean {
  if (!roles) return false;
  switch (gate) {
    case 'recruiter':
      return roles.admin || roles.recruiter !== null;
    case 'dept':
      return roles.admin || roles.dept !== null;
    case 'any':
      return hasHrAccess(roles);
    case 'hireFast':
    case 'automatedMessages':
      return hrInboxLinks(roles)[gate];
  }
}

export interface NavGroup {
  id:
    | 'main'
    | 'conversations'
    | 'customers'
    | 'submissions'
    | 'collaboration'
    | 'team'
    | 'hr'
    | 'automation'
    | 'integrations';
  /** Heading key in the `Sidebar` namespace; null renders no heading. */
  labelKey: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'main',
    labelKey: null,
    items: [
      // Notifications are the top bar's bell (NotificationBell), not a row
      // here; the full list page stays as its "View all".
      { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
    ],
  },
  {
    id: 'collaboration',
    labelKey: 'groups.collaboration',
    items: [
      // Team chat (migration 087): the one row a bank guest sees too.
      {
        href: '/chat',
        labelKey: 'chat',
        icon: MessagesSquare,
        guestVisible: true,
      },
      // Video meetings (migration 106): every staff role, never a bank
      // guest; the route's layout turns a guest away on the server, and
      // which meetings come back is RLS's call (`meeting_can_view`).
      { href: '/meetings', labelKey: 'meetings', icon: Video, guarded: true },
      {
        href: '/calendar',
        labelKey: 'calendar',
        icon: CalendarDays,
        guarded: true,
      },
    ],
  },
  {
    id: 'conversations',
    labelKey: 'groups.conversations',
    items: [
      { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
      // Missed calls and the call log (module 015). Staff only: the
      // route's layout turns a bank guest away; which calls come back is
      // RLS's call (`pbx_can_view_call`).
      {
        href: '/calls',
        labelKey: 'calls',
        icon: Phone,
        needsPbx: true,
        guarded: true,
      },
      // WhatsApp groups on the Whapi numbers (migration 114): every staff
      // role, never a bank guest; the route's layout turns a guest away,
      // and which groups come back is RLS's call
      // (whatsapp_group_visible_ids).
      {
        href: '/groups',
        labelKey: 'whatsappGroups',
        icon: UsersRound,
        guarded: true,
      },
    ],
  },
  {
    id: 'customers',
    labelKey: 'groups.customers',
    items: [
      { href: '/contacts', labelKey: 'contacts', icon: Users },
      // Everyone's: each member works their own deals, a team leader
      // their team's too, an admin all of them. Which deals come back
      // is RLS's call (migration 080, `can_view_deal`).
      { href: '/pipelines', labelKey: 'pipelines', icon: GitBranch },
      // The journey bot's files (module 016): advisors act on them, so
      // agents and up; the route's layout enforces it server-side.
      {
        href: '/journeys',
        labelKey: 'journeys',
        icon: Route,
        minRole: 'agent',
        guarded: true,
      },
    ],
  },
  {
    id: 'submissions',
    labelKey: 'groups.submissions',
    items: [
      // Cases (module 019): the coordinator inbox over submission cases.
      // Agent and up (the route's AgentOnlyLayout); which cases come back
      // is Postgres's call (`case_inbox`, case_role).
      {
        href: '/cases',
        labelKey: 'cases',
        icon: Briefcase,
        minRole: 'agent',
        guarded: true,
      },
      // Submission groups (module 018a): one WhatsApp group per submitted
      // case. Agent and up (the route's AgentOnlyLayout); which groups
      // come back is the access list's call, server-side.
      {
        href: '/submission-groups',
        labelKey: 'submissionGroups',
        icon: FolderKanban,
        minRole: 'agent',
        guarded: true,
      },
      // Partner banks (module 019): agent and up, like Cases.
      {
        href: '/banks',
        labelKey: 'banks',
        icon: Landmark,
        minRole: 'agent',
        guarded: true,
      },
      // Second brain search (package 022e, migration 194): agent and up,
      // only while the workspace has it switched on.
      {
        href: '/brain',
        labelKey: 'brain',
        icon: Brain,
        minRole: 'agent',
        guarded: true,
        needsBrain: true,
      },
      // The second brain's Daily digest: the same gate as /brain.
      {
        href: '/digest',
        labelKey: 'digest',
        icon: ListChecks,
        minRole: 'agent',
        guarded: true,
        needsBrain: true,
      },
    ],
  },
  {
    id: 'team',
    labelKey: 'groups.team',
    items: [
      // A team leader's wider view of Inbox and Contacts. Admins see
      // them too (they outrank a leader); what each gets back is RLS's
      // call.
      {
        href: '/team-inbox',
        labelKey: 'teamInbox',
        icon: Inbox,
        minRole: 'team_leader',
        guarded: true,
      },
      {
        href: '/team-contacts',
        labelKey: 'teamContacts',
        icon: ContactRound,
        minRole: 'team_leader',
        guarded: true,
      },
      // The recorded calls of the people a leader leads (an admin:
      // everyone's), to listen back by person. The route's layout is the
      // team_leader+ guard; which calls come back is RLS's call
      // (pbx_can_view_call) narrowed to the caller's people.
      {
        href: '/calls/recordings',
        labelKey: 'teamRecordings',
        icon: AudioLines,
        minRole: 'team_leader',
        callReviewerVisible: true,
        needsPbx: true,
        guarded: true,
      },
      // Who starts chats and how many get an answer, against the limits
      // that keep a Whapi number from being restricted (migration 068).
      // A team leader sees their own team's (migration 074).
      {
        href: '/team-activity',
        labelKey: 'teamActivity',
        icon: Activity,
        minRole: 'team_leader',
        guarded: true,
      },
      // A person's own figures against those limits, their blocked sends
      // and unlock requests (migration 205). The route's layout is the
      // agent+ guard; the report route answers 403 while switched off.
      {
        href: '/my-activity',
        labelKey: 'myActivity',
        icon: UserCheck,
        minRole: 'agent',
        guarded: true,
      },
    ],
  },
  // HR (migrations 192, 200): HR people's chats, which leave the
  // inboxes above, one route per inbox, then the HR tools. Owners and
  // admins see every row; an HR team member the rows their roles open
  // (`hr`, see hrGateOpen). Each route's HrAccessLayout guards it.
  {
    id: 'hr',
    labelKey: 'groups.hr',
    items: [
      {
        href: '/hr/recruiter',
        labelKey: 'hrRecruiter',
        icon: UserSearch,
        hr: 'recruiter',
        guarded: true,
      },
      {
        href: '/hr/department',
        labelKey: 'hrDepartment',
        icon: IdCard,
        hr: 'dept',
        guarded: true,
      },
      // HR-department chats with no HR row yet (neither a candidate
      // nor an employee topic), so they have somewhere to be sorted.
      {
        href: '/hr/unsorted',
        labelKey: 'hrUnsorted',
        icon: Inbox,
        hr: 'any',
        guarded: true,
      },
      {
        href: '/hr/tasks',
        labelKey: 'hrTasks',
        icon: ListTodo,
        hr: 'any',
        guarded: true,
      },
      {
        href: '/hr/rules',
        labelKey: 'hrRules',
        icon: SlidersHorizontal,
        hr: 'any',
        guarded: true,
      },
      {
        href: '/hr/hire-fast',
        labelKey: 'hrHireFast',
        icon: Rocket,
        hr: 'hireFast',
        guarded: true,
      },
      {
        href: '/hr/automated-messages',
        labelKey: 'hrAutomatedMessages',
        icon: MessageSquareText,
        hr: 'automatedMessages',
        guarded: true,
      },
    ],
  },
  // Workspace configuration from here down: these shape how the whole
  // account operates, so they are admin+ only.
  {
    id: 'automation',
    labelKey: 'groups.automation',
    items: [
      {
        href: '/broadcasts',
        labelKey: 'broadcasts',
        icon: Radio,
        minRole: 'admin',
        guarded: true,
      },
      {
        href: '/automations',
        labelKey: 'automations',
        icon: Zap,
        minRole: 'admin',
        guarded: true,
      },
      {
        href: '/flows',
        labelKey: 'flows',
        icon: Workflow,
        beta: true,
        minRole: 'admin',
        guarded: true,
      },
    ],
  },
  {
    id: 'integrations',
    labelKey: 'groups.integrations',
    items: [
      // Customers synced from the Compass ERP (migration 056) — ERP PII,
      // admin+ like its RLS.
      {
        href: '/compass',
        labelKey: 'compass',
        icon: Building2,
        minRole: 'admin',
        guarded: true,
      },
      // Contacts the OpenDesk sales app marked Interested (migration
      // 139) — sales-app PII, admin+ like its RLS.
      {
        href: '/opendesk',
        labelKey: 'opendesk',
        icon: Headset,
        minRole: 'admin',
        guarded: true,
      },
    ],
  },
];

/** Set apart at the foot of the nav, below every group. */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { href: '/settings', labelKey: 'settings', icon: Settings },
];

/**
 * The groups `role` may see, each cut down to the items it may open; a
 * group left empty is dropped. Pass null while the profile is loading:
 * that fails CLOSED to the ungated items, because showing an admin-only
 * row for a moment and yanking it away both leaks the surface and
 * reflows the sidebar. The routes are independently guarded
 * server-side, so this is presentation, not the security boundary.
 */
export function visibleNavGroups(
  role: AccountRole | null,
  ctx: NavContext = {}
): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => isNavItemVisible(item, role, ctx)),
  })).filter((group) => group.items.length > 0);
}

/** The rows of `items` this person may see (restricted departments lose sales areas). */
export function visibleNavItems<T extends { href: string }>(
  items: readonly T[],
  { salesRestricted }: { salesRestricted: boolean }
): T[] {
  return items.filter(
    (item) => !(salesRestricted && isRestrictedPath(item.href))
  );
}

/** The foot-of-nav rows `role` may see (Settings is staff-only). */
export function visibleBottomNavItems(role: AccountRole | null): NavItem[] {
  return BOTTOM_NAV_ITEMS.filter((item) => isNavItemVisible(item, role));
}

/**
 * May `role` see `item`? A bank guest sees only `guestVisible` rows;
 * staff are gated by `minRole` (none = every staff member), and a
 * `needsPbx` row by `ctx.pbx`; a `callReviewerVisible` row passes its
 * `minRole` for a call reviewer (`ctx.callReviewer`); an `hr` row is
 * for admins and the HR roles its gate names (`ctx.hrRoles`). Null (the
 * profile still loading) shows the ungated rows, as above.
 */
export function isNavItemVisible(
  item: NavItem,
  role: AccountRole | null,
  ctx: NavContext = {}
): boolean {
  if (isBankGuest(role)) return !!item.guestVisible;
  if (ctx.salesRestricted && isRestrictedPath(item.href)) return false;
  if (item.needsPbx && !(role && ctx.pbx)) return false;
  if (item.needsBrain && !(role && ctx.brain)) return false;
  if (item.callReviewerVisible && role && ctx.callReviewer) return true;
  if (item.hr)
    return (
      !!role &&
      (hasMinRole(role, 'admin') || hrGateOpen(item.hr, ctx.hrRoles ?? null))
    );
  return !item.minRole || (!!role && hasMinRole(role, item.minRole));
}

/**
 * Does `pathname` belong to `href`'s row? Sub-pages light their parent
 * (/broadcasts/123 → Broadcasts) — matched on a whole path segment, so
 * /team-inbox never lights Inbox — except the dashboard, which lights
 * only on itself.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  if (pathname === href) return true;
  return href !== '/dashboard' && pathname.startsWith(`${href}/`);
}

/**
 * The sidebar row's `<Link prefetch>`. A {@link NavItem.guarded} route is
 * dynamic, so `auto` prefetches only down to the dashboard's loading
 * boundary and the click still waits out the RSC round trip (~0.4–0.7 s
 * through the tunnel). `true` prefetches it fully and the router holds
 * it for `staleTimes.static` (next.config.ts), guard answer included;
 * the rows are rendered only for a role that may open them, and RLS is
 * what keeps the data from a demoted user. Every other row is a static
 * route that `auto` already prefetches fully: null keeps the default.
 */
export function navPrefetch(item: NavItem): true | null {
  return item.guarded ? true : null;
}
