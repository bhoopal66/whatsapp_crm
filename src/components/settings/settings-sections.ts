import {
  Blocks,
  Bot,
  Building2,
  CircleDollarSign,
  Coins,
  FileText,
  Handshake,
  Inbox,
  KeyRound,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  Network,
  Palette,
  PhoneCall,
  PlugZap,
  Route,
  ScrollText,
  Shield,
  ShieldCheck,
  Smartphone,
  Tag,
  TextCursorInput,
  User,
  UsersRound,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { isAgentTab } from '@/lib/ai/agent-tabs';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/**
 * Settings information architecture: a row of category tabs, each with
 * a row of sub-tabs (sections).
 *
 * The URL key is `?tab=<section id>` — the category is derived from it,
 * so every link written before the tabs existed keeps working. The one
 * exception is AI Agents, whose own tab bar is the sub-tab row: it is
 * `?tab=ai` (the area's default landing) or `?tab=ai-<agent tab>`
 * (`?tab=ai-safety` → Safety checks), so `?tab=` stays the single key.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'numbers',
  'routing',
  'templates',
  'deal-rooms',
  'costs',
  'chat-tags',
  'quick-replies',
  'fields',
  'journey-bot',
  'workspace',
  'members',
  'teams',
  'team-chat',
  'consent-retention',
  'audit-log',
  'ai',
  'api',
  'deals',
  'phone-system',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_CATEGORIES = [
  'overview',
  'account',
  'whatsapp',
  'inbox',
  'team',
  'ai',
  'integrations',
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

export interface SectionMeta {
  id: SettingsSection;
  icon: LucideIcon;
  category: SettingsCategory;
  /**
   * Minimum role that may open this section. Omitted means every
   * member of the account.
   *
   * Everything outside Overview and My account is admin+: it configures
   * the account as a whole — the WhatsApp numbers, the templates
   * everyone sends, the fields on every contact, who is on the team,
   * the AI that answers customers, and API keys with account-wide
   * authority. My account stays open to everyone because those are the
   * user's OWN settings (profile, password, theme).
   */
  minRole?: AccountRole;
}

/** In display order within each category. */
export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', icon: LayoutGrid, category: 'overview' },
  profile: { id: 'profile', icon: User, category: 'account' },
  security: { id: 'security', icon: Shield, category: 'account' },
  appearance: { id: 'appearance', icon: Palette, category: 'account' },
  whatsapp: {
    id: 'whatsapp',
    icon: PlugZap,
    category: 'whatsapp',
    minRole: 'admin',
  },
  // Naming numbers and deciding who works each one (migration 060).
  numbers: {
    id: 'numbers',
    icon: Smartphone,
    category: 'whatsapp',
    minRole: 'admin',
  },
  // Which number sends what (migration 046), minus the AI's number,
  // which AI Agents → Auto-reply → "Reply on" owns.
  routing: {
    id: 'routing',
    icon: Route,
    category: 'whatsapp',
    minRole: 'admin',
  },
  templates: {
    id: 'templates',
    icon: FileText,
    category: 'whatsapp',
    minRole: 'admin',
  },
  // The group-invite template of the deal rooms (migration 088's
  // deal_room_settings): a Meta template, so beside Templates.
  'deal-rooms': {
    id: 'deal-rooms',
    icon: Handshake,
    category: 'whatsapp',
    minRole: 'admin',
  },
  // Message spend is billing-class, like the ledger's SELECT policy.
  costs: {
    id: 'costs',
    icon: CircleDollarSign,
    category: 'whatsapp',
    minRole: 'admin',
  },
  // The colour-coded tags a chat carries (migration 075). Only admins
  // write them (RLS); every member reads them in the inbox.
  'chat-tags': {
    id: 'chat-tags',
    icon: Tag,
    category: 'inbox',
    minRole: 'admin',
  },
  'quick-replies': {
    id: 'quick-replies',
    icon: Zap,
    category: 'inbox',
    minRole: 'admin',
  },
  fields: {
    id: 'fields',
    icon: TextCursorInput,
    category: 'inbox',
    minRole: 'admin',
  },
  // The journey bot (module 016). Inbox, not AI Agents: it is a fixed
  // workflow rather than an AI agent, it works the inbox's chats, and
  // the AI category's sub-tab row is the AI Agents area's own tab bar.
  'journey-bot': {
    id: 'journey-bot',
    icon: Workflow,
    category: 'inbox',
    minRole: 'admin',
  },
  // The workspace's name and its rail tile's short name (PATCH
  // /api/account, admin+), first in Team: the workspace the team is.
  workspace: {
    id: 'workspace',
    icon: Building2,
    category: 'team',
    minRole: 'admin',
  },
  members: {
    id: 'members',
    icon: UsersRound,
    category: 'team',
    minRole: 'admin',
  },
  teams: { id: 'teams', icon: Network, category: 'team', minRole: 'admin' },
  // Internal chat (migration 087): the workspace switch, the audited
  // private read and the owner-only erasure. Admin+, like the RPCs.
  'team-chat': {
    id: 'team-chat',
    icon: MessagesSquare,
    category: 'team',
    minRole: 'admin',
  },
  // Bank guests and recording per bank (088's bank_guest_policies,
  // admin-written), the retention summary and the owner-only erasure of
  // a customer's call recordings. Team, beside Team chat's own erasure:
  // both answer who may see what of the people the team works with.
  'consent-retention': {
    id: 'consent-retention',
    icon: ShieldCheck,
    category: 'team',
    minRole: 'admin',
  },
  // One newest-first list over the five audit tables of 087-089 and 092,
  // each of which RLS opens to admins of the active account (GET
  // /api/audit).
  'audit-log': {
    id: 'audit-log',
    icon: ScrollText,
    category: 'team',
    minRole: 'admin',
  },
  // The AI Agents area, admin-only like the /agents screen it replaced
  // (and the TypeSafe API routes behind its Safety checks tab).
  ai: { id: 'ai', icon: Bot, category: 'ai', minRole: 'admin' },
  api: {
    id: 'api',
    icon: KeyRound,
    category: 'integrations',
    minRole: 'admin',
  },
  deals: {
    id: 'deals',
    icon: Coins,
    category: 'integrations',
    minRole: 'admin',
  },
  // The Yeastar PBX (migration 089): an outside system wired in, like
  // the API keys. Admin+, like every /api/pbx admin route behind it.
  'phone-system': {
    id: 'phone-system',
    icon: PhoneCall,
    category: 'integrations',
    minRole: 'admin',
  },
};

export const CATEGORY_ICONS: Record<SettingsCategory, LucideIcon> = {
  overview: LayoutGrid,
  account: User,
  whatsapp: MessageCircle,
  inbox: Inbox,
  team: UsersRound,
  ai: Bot,
  integrations: Blocks,
};

/** A category's sections, in display order. */
export function sectionsOf(category: SettingsCategory): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => SECTION_META[s].category === category);
}

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/** Where a raw `?tab=` value points, before any role check. */
export interface SettingsTarget {
  section: SettingsSection;
  /** The AI Agents tab asked for (raw: the area validates it), or null
   *  for its default landing. Always null outside `ai`. */
  agentTab: string | null;
}

/**
 * Resolve a raw `?tab=` value. Legacy ids collapse onto their new home:
 * `tags` → Chat tags (the only tag system left), `custom-fields` →
 * Custom fields, `ai-safety` (the old AI safety checks section) → AI
 * Agents → Safety checks. Anything unknown is the Overview.
 */
export function resolveSettingsTab(raw: string | null): SettingsTarget {
  if (raw === 'tags') return { section: 'chat-tags', agentTab: null };
  if (raw === 'custom-fields') return { section: 'fields', agentTab: null };
  if (raw?.startsWith('ai-')) {
    return { section: 'ai', agentTab: raw.slice('ai-'.length) || null };
  }
  if (isSection(raw)) return { section: raw, agentTab: null };
  return { section: DEFAULT_SECTION, agentTab: null };
}

/** The `?tab=` value for an AI Agents tab. */
export function aiTabParam(agentTab: string): string {
  return `ai-${agentTab}`;
}

/**
 * May a caller with `role` open `section`?
 *
 * One predicate behind every way into a section — the tab rows, the
 * panel switch behind `?tab=`, and the Overview tiles — so none of them
 * can drift and leave a section reachable by a route nobody gated.
 *
 * `role` is null while the profile is still loading. That answers
 * "no": showing a tab for a frame and then removing it both leaks the
 * surface and reflows the row.
 */
export function canOpenSection(
  section: SettingsSection,
  role: AccountRole | null
): boolean {
  const min = SECTION_META[section].minRole;
  if (!min) return true;
  return !!role && hasMinRole(role, min);
}

/** The categories `role` may see, each with its openable sections; a
 *  category left with none is dropped. */
export function visibleCategories(
  role: AccountRole | null
): { id: SettingsCategory; sections: SettingsSection[] }[] {
  return SETTINGS_CATEGORIES.map((id) => ({
    id,
    sections: sectionsOf(id).filter((s) => canOpenSection(s, role)),
  })).filter((c) => c.sections.length > 0);
}

export interface SettingsLocation extends SettingsTarget {
  category: SettingsCategory;
}

/**
 * The location to render for the current URL. `?tab=` is user-supplied,
 * so resolving it is not the same as being allowed to see it: anything
 * below the section's minimum role lands on the Overview, which every
 * member can see (this also covers an admin demoted with a tab open).
 */
export function resolveSettingsLocation(
  params: { get(name: string): string | null },
  role: AccountRole | null
): SettingsLocation {
  const target = resolveSettingsTab(params.get('tab'));
  const allowed = canOpenSection(target.section, role)
    ? target
    : { section: DEFAULT_SECTION, agentTab: null };
  return { ...allowed, category: SECTION_META[allowed.section].category };
}

/** Query params that belong to one section's own state. */
const SECTION_STATE_PARAMS = ['channel', 'add'] as const;

/**
 * The query string after switching to `nextTab`. Other params survive,
 * but a section's own state (`channel`, `add`) is dropped when the
 * section changes, so it cannot leak into the next visit of that panel.
 */
export function settingsParamsFor(
  current: string,
  nextTab: string
): URLSearchParams {
  const params = new URLSearchParams(current);
  const from = resolveSettingsTab(params.get('tab')).section;
  if (resolveSettingsTab(nextTab).section !== from) {
    for (const key of SECTION_STATE_PARAMS) params.delete(key);
  }
  params.set('tab', nextTab);
  return params;
}

/**
 * Does switching `?tab=` from `currentTab` to `nextTab` unmount the AI
 * Agents area? Its unsaved form lives only while the area is on
 * screen, so moving between its own tabs is safe and anything else
 * drops the edits.
 */
export function leavesAiArea(
  currentTab: string | null,
  nextTab: string | null
): boolean {
  return (
    resolveSettingsTab(currentTab).section === 'ai' &&
    resolveSettingsTab(nextTab).section !== 'ai'
  );
}

/**
 * Where an in-app link (`href` as written on the anchor) would take the
 * user away from the AI Agents area, as a path to `router.push`; null
 * when it would not. Other origins and non-http schemes are left to the
 * browser (`beforeunload` covers a full page load), a hash-only link
 * stays on the page, and `/settings?tab=ai…` stays in the area. Every
 * other same-origin path leaves — `/agents` included: it redirects back
 * here, but as a fresh mount with the edits gone.
 */
export function inAppLeaveTarget(href: string, origin: string): string | null {
  if (!href || href.startsWith('#')) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (
    url.pathname === '/settings' &&
    resolveSettingsTab(url.searchParams.get('tab')).section === 'ai'
  ) {
    return null;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where `/agents?tab=<x>` now lives. */
export function agentsRedirectHref(tab: string | string[] | undefined): string {
  const raw = Array.isArray(tab) ? tab[0] : tab;
  // `?tab=` is user-supplied and lands in a URL: only a known AI Agents
  // tab passes (the pre-tabs `setup` is Assistant); anything else is the
  // area's default landing.
  const value = raw === 'setup' ? 'assistant' : raw;
  return `/settings?tab=${isAgentTab(value) ? aiTabParam(value) : 'ai'}`;
}
