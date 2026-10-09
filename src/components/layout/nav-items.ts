import {
  Activity,
  Bell,
  Building2,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Radio,
  Settings,
  Users,
  UsersRound,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

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
      { href: '/notifications', labelKey: 'notifications', icon: Bell },
      { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
      { href: '/contacts', labelKey: 'contacts', icon: Users },
      // Everyone's: each member works their own deals, a team leader
      // their team's too, an admin all of them. Which deals come back
      // is RLS's call (migration 080, `can_view_deal`).
      { href: '/pipelines', labelKey: 'pipelines', icon: GitBranch },
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
export function visibleNavGroups(role: AccountRole | null): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.minRole || (!!role && hasMinRole(role, item.minRole))
    ),
  })).filter((group) => group.items.length > 0);
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
