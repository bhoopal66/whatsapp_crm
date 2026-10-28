import { hasMinRole, isBankGuest, type AccountRole } from '@/lib/auth/roles';

/**
 * The home dashboard's widgets, and who gets each one.
 *
 * This is presentation, not access control: every figure a widget shows
 * comes back through the person's own RLS or through a route that checks
 * the role again, so a widget shown by mistake would only show empty.
 * The point is not to offer a panel whose link bounces the person back
 * here, or whose figures are always zero for their role.
 */
export const HOME_WIDGETS = [
  'attention',
  'tasks',
  'agenda',
  'cases',
  'calls',
  'outreach',
  'pipeline',
  'team',
  'numbers',
  'campaigns',
  'trends',
] as const;

export type HomeWidget = (typeof HOME_WIDGETS)[number];

/** The least role that gets each widget. */
const MIN_ROLE: Record<HomeWidget, AccountRole> = {
  // Unread chats and AI hand-offs: everyone who can open the inbox.
  attention: 'viewer',
  // Tasks are held by agents and up (`TASK_HOLDER_ROLES`, migration 085).
  tasks: 'agent',
  // The calendar is every staff role's (`canUseMeetings`).
  agenda: 'viewer',
  // /cases is agent and up, and `case_inbox` gives a viewer nothing.
  cases: 'agent',
  // Also needs the phone system (`HomeContext.pbx`); `pbx_call_stats`
  // decides whose calls are counted.
  calls: 'viewer',
  // Chats this person started today: only someone who sends. Also needs
  // a phone number (`HomeContext.phoneNumbers`).
  outreach: 'agent',
  pipeline: 'viewer',
  // Team activity is team leader and up (migration 074).
  team: 'team_leader',
  // Number health and campaigns live on admin screens.
  numbers: 'admin',
  campaigns: 'admin',
  trends: 'viewer',
};

/** What the dashboard knows beyond the role. */
export interface HomeContext {
  /**
   * The person can use the phone system: the workspace has an extension
   * (`loadCallsBadge`'s `hasPbx`, the rule the sidebar's Calls row uses).
   */
  pbx: boolean;
  /**
   * The workspace has a number the new-chat limits apply to: a linked
   * device (Whapi or OpenWA), not the Cloud API.
   */
  phoneNumbers: boolean;
}

/**
 * The widgets `role` gets. Null (the profile still loading) and a bank
 * guest get none: the shell keeps a guest on /chat anyway.
 */
export function homeWidgets(
  role: AccountRole | null,
  ctx: HomeContext
): ReadonlySet<HomeWidget> {
  const out = new Set<HomeWidget>();
  if (!role || isBankGuest(role)) return out;
  for (const widget of HOME_WIDGETS) {
    if (!hasMinRole(role, MIN_ROLE[widget])) continue;
    if (widget === 'calls' && !ctx.pbx) continue;
    if (widget === 'outreach' && !ctx.phoneNumbers) continue;
    out.add(widget);
  }
  return out;
}
