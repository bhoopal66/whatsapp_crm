import {
  Coins,
  Network,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'members',
  'teams',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. Sections carrying `minRole` are hidden from — and
 *  unreachable by — anyone below that role. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
  /**
   * Minimum role that may open this section. Omitted means every
   * member of the account.
   *
   * Every `workspace` section is admin+: they configure the account as
   * a whole — the WhatsApp channel, the templates everyone sends, the
   * fields on every contact, who is on the team, and API keys that act
   * with account-wide authority. The `account` group stays open to
   * everyone because those are the user's OWN settings (their profile,
   * their password, their theme), which are not privileged.
   */
  minRole?: AccountRole;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace', minRole: 'admin' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace', minRole: 'admin' },
  'quick-replies': { id: 'quick-replies', label: 'Quick replies', icon: Zap, group: 'workspace', minRole: 'admin' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace', minRole: 'admin' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace', minRole: 'admin' },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace', minRole: 'admin' },
  teams: { id: 'teams', label: 'Teams', icon: Network, group: 'workspace', minRole: 'admin' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace', minRole: 'admin' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}

/**
 * May a caller with `role` open `section`?
 *
 * One predicate, used by all three surfaces that can reach a section —
 * the rail, the panel switch behind `?tab=`, and the Overview cards —
 * so none of them can drift out of step with the others and leave a
 * section reachable by a route nobody thought to gate.
 *
 * `role` is null while the profile is still loading. That answers
 * "no": showing a section for a frame and then removing it both leaks
 * the surface and reflows the rail.
 */
export function canOpenSection(
  section: SettingsSection,
  role: AccountRole | null,
): boolean {
  const min = SECTION_META[section].minRole;
  if (!min) return true;
  return !!role && hasMinRole(role, min);
}
