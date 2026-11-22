import {
  Keyboard,
  Megaphone,
  UserPlus,
  Video,
  type LucideIcon,
} from 'lucide-react';

import {
  BOTTOM_NAV_ITEMS,
  isNavItemVisible,
  visibleNavGroups,
  type NavContext,
  type NavItem,
} from '@/components/layout/nav-items';
import {
  canOpenSection,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from '@/components/settings/settings-sections';
import {
  canCreateMeetings,
  canSendMessages,
  type AccountRole,
} from '@/lib/auth/roles';

/** Which message namespace a label key lives in. */
export type LabelNs = 'Sidebar' | 'Settings' | 'CommandBar';

export interface CommandEntry {
  /** Unique, stable. */
  id: string;
  kind: 'page' | 'action' | 'setting';
  label: { ns: LabelNs; key: string };
  /** Extra searchable text key (same namespace as `label`), if any. */
  keywordsKey?: string;
  /** Muted caption: the sidebar group heading key (`Sidebar`). */
  captionKey?: string;
  icon: LucideIcon;
  /** Where it goes. Absent for in-app commands (see `run`). */
  href?: string;
  /** An in-app command instead of a link. */
  run?: 'shortcuts';
  /** Shown only once the person has typed something. */
  searchOnly?: boolean;
}

export interface CommandRoleContext {
  /** Null while the profile loads: fails closed, like the sidebar. */
  role: AccountRole | null;
  nav: NavContext;
}

/** The sidebar's own rows for this person, flattened, in order. */
export function visibleNavEntries(ctx: CommandRoleContext): CommandEntry[] {
  const out: CommandEntry[] = [];
  const seen = new Set<string>();
  const push = (item: NavItem, captionKey?: string) => {
    if (seen.has(item.href)) return;
    seen.add(item.href);
    out.push({
      id: `page:${item.href}`,
      kind: 'page',
      label: { ns: 'Sidebar', key: item.labelKey },
      captionKey,
      icon: item.icon,
      href: item.href,
    });
  };
  for (const group of visibleNavGroups(ctx.role, ctx.nav)) {
    for (const item of group.items) push(item, group.labelKey ?? undefined);
  }
  for (const item of BOTTOM_NAV_ITEMS) {
    if (isNavItemVisible(item, ctx.role, ctx.nav)) push(item);
  }
  return out;
}

interface ActionDef {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  href: string;
  /** The screen the action lives on must itself be openable. */
  requiresHref: string;
  can: (role: AccountRole) => boolean;
}

// The new-broadcast wizard has its own URL. Adding a contact and
// creating a meeting open from a button on their list screens, with no
// URL of their own, so those link to the list.
const ACTIONS: readonly ActionDef[] = [
  {
    id: 'new-broadcast',
    labelKey: 'actions.newBroadcast',
    icon: Megaphone,
    href: '/broadcasts/new',
    requiresHref: '/broadcasts',
    can: canSendMessages,
  },
  {
    id: 'add-contact',
    labelKey: 'actions.addContact',
    icon: UserPlus,
    href: '/contacts',
    requiresHref: '/contacts',
    can: canSendMessages,
  },
  {
    id: 'new-meeting',
    labelKey: 'actions.newMeeting',
    icon: Video,
    href: '/meetings',
    requiresHref: '/meetings',
    can: canCreateMeetings,
  },
];

/** The actions this person may use. */
export function actionEntries(
  ctx: CommandRoleContext,
  navHrefs: ReadonlySet<string>
): CommandEntry[] {
  const { role } = ctx;
  if (!role) return [];
  return ACTIONS.filter((a) => navHrefs.has(a.requiresHref) && a.can(role)).map(
    (a) => ({
      id: `action:${a.id}`,
      kind: 'action' as const,
      label: { ns: 'CommandBar' as const, key: a.labelKey },
      icon: a.icon,
      href: a.href,
    })
  );
}

/** Every Settings section this person may open (except the Overview). */
export function settingEntries(
  role: AccountRole | null,
  salesRestricted: boolean
): CommandEntry[] {
  // Still loading: offer nothing rather than a section that then vanishes.
  if (!role) return [];
  return SETTINGS_SECTIONS.filter(
    (s): s is SettingsSection =>
      s !== 'overview' && canOpenSection(s, role, salesRestricted)
  ).map((s) => ({
    id: `setting:${s}`,
    kind: 'setting' as const,
    label: { ns: 'Settings' as const, key: `sections.${s}` },
    keywordsKey: `keywords.${s}`,
    icon: SECTION_META[s].icon,
    href: `/settings?tab=${s}`,
    searchOnly: true,
  }));
}

/**
 * Everything the bar can offer this person: pages, then actions, then
 * Settings sections. Nothing the role cannot open is ever built, so the
 * component has no filtering of its own to get wrong.
 */
export function buildCommandEntries(
  ctx: CommandRoleContext,
  salesRestricted: boolean
): CommandEntry[] {
  const pages = visibleNavEntries(ctx);
  const hrefs = new Set(pages.map((p) => p.href as string));
  return [
    ...pages,
    ...actionEntries(ctx, hrefs),
    ...settingEntries(ctx.role, salesRestricted),
    // Help is for everyone who can open the bar.
    {
      id: 'action:shortcuts',
      kind: 'action',
      label: { ns: 'CommandBar', key: 'actions.shortcuts' },
      icon: Keyboard,
      run: 'shortcuts',
      searchOnly: true,
    },
  ];
}
