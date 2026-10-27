import {
  Activity,
  Briefcase,
  Building2,
  GitBranch,
  Headset,
  Landmark,
  LayoutDashboard,
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
} from 'lucide-react';

import { hasMinRole, isBankGuest, type AccountRole } from '@/lib/auth/roles';

/**
 * The sidebar's information architecture.
 *
 * Grouped by who each destination is for, which is also how the role
 * ladder gates them: the opening group is every member's daily work
 * (their chats, contacts and deals) and carries no heading, Team is a team leader's wider view, and the rest
 * configure the account and are admin+. So an agent sees one short list
 * with no headings, and no role is shown a heading over nothing.
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
}

/** What the sidebar knows beyond the role. */
export interface NavContext {
  /** This person can use the phone system (`callsSidebar(…).visible`). */
  pbx?: boolean;
}

export interface NavGroup {
  id: 'main' | 'team' | 'sales' | 'automation' | 'integrations';
  /** Heading key in the `Sidebar` namespace; null renders no heading. */
  labelKey: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'main',
    labelKey: null,
    items: [
      { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
      // Notifications are the top bar's bell (NotificationBell), not a row
      // here; the full list page stays as its "View all".
      { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
      // Missed calls and the call log (module 015). Staff only: the
      // route's layout turns a bank guest away; which calls come back is
      // RLS's call (`pbx_can_view_call`).
      { href: '/calls', labelKey: 'calls', icon: Phone, needsPbx: true },
      // WhatsApp groups on the Whapi numbers (migration 114): every staff
      // role, never a bank guest; the route's layout turns a guest away,
      // and which groups come back is RLS's call
      // (whatsapp_group_visible_ids).
      { href: '/groups', labelKey: 'whatsappGroups', icon: UsersRound },
      // Submission groups (module 018a): one WhatsApp group per submitted
      // case. Agent and up (the route's AgentOnlyLayout); which groups
      // come back is the access list's call, server-side.
      {
        href: '/submission-groups',
        labelKey: 'submissionGroups',
        icon: FolderKanban,
        minRole: 'agent',
      },
      // Cases (module 019): the coordinator inbox over submission cases.
      // Agent and up (the route's AgentOnlyLayout); which cases come back
      // is Postgres's call (`case_inbox`, case_role).
      {
        href: '/cases',
        labelKey: 'cases',
        icon: Briefcase,
        minRole: 'agent',
      },
      // Partner banks (module 019): agent and up, like Cases.
      {
        href: '/banks',
        labelKey: 'banks',
        icon: Landmark,
        minRole: 'agent',
      },
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
      { href: '/meetings', labelKey: 'meetings', icon: Video },
      { href: '/calendar', labelKey: 'calendar', icon: CalendarDays },
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
      },
    ],
  },
  {
    id: 'team',
    labelKey: 'groups.team',
    items: [
      // Team leader's wider view of the same two screens. Admins see
      // them too (they outrank a leader); what each gets back is RLS's
      // call.
      {
        href: '/team-inbox',
        labelKey: 'teamInbox',
        icon: MessagesSquare,
        minRole: 'team_leader',
      },
      {
        href: '/team-contacts',
        labelKey: 'teamContacts',
        icon: UsersRound,
        minRole: 'team_leader',
      },
      // Who starts chats and how many get an answer, against the limits
      // that keep a Whapi number from being restricted (migration 068).
      // A team leader sees their own team's (migration 074).
      {
        href: '/team-activity',
        labelKey: 'teamActivity',
        icon: Activity,
        minRole: 'team_leader',
      },
    ],
  },
  // Workspace configuration from here down: these shape how the whole
  // account operates, so they are admin+ only.
  {
    id: 'sales',
    labelKey: 'groups.sales',
    items: [
      {
        href: '/broadcasts',
        labelKey: 'broadcasts',
        icon: Radio,
        minRole: 'admin',
      },
    ],
  },
  {
    id: 'automation',
    labelKey: 'groups.automation',
    items: [
      {
        href: '/automations',
        labelKey: 'automations',
        icon: Zap,
        minRole: 'admin',
      },
      {
        href: '/flows',
        labelKey: 'flows',
        icon: Workflow,
        beta: true,
        minRole: 'admin',
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
      },
      // Contacts the OpenDesk sales app marked Interested (migration
      // 139) — sales-app PII, admin+ like its RLS.
      {
        href: '/opendesk',
        labelKey: 'opendesk',
        icon: Headset,
        minRole: 'admin',
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

/** The foot-of-nav rows `role` may see (Settings is staff-only). */
export function visibleBottomNavItems(role: AccountRole | null): NavItem[] {
  return BOTTOM_NAV_ITEMS.filter((item) => isNavItemVisible(item, role));
}

/**
 * May `role` see `item`? A bank guest sees only `guestVisible` rows;
 * staff are gated by `minRole` (none = every staff member), and a
 * `needsPbx` row by `ctx.pbx`. Null (the profile still loading) shows
 * the ungated rows, as above.
 */
export function isNavItemVisible(
  item: NavItem,
  role: AccountRole | null,
  ctx: NavContext = {}
): boolean {
  if (isBankGuest(role)) return !!item.guestVisible;
  if (item.needsPbx && !(role && ctx.pbx)) return false;
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
