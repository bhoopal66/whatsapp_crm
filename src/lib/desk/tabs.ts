/**
 * The case desk's daily-work tabs and the `?tab=` that keeps the open one
 * in the link. Pure, so it is tested without a DOM. The admin settings
 * (desk codes, WhatsApp routing, reminder digest, bank roles) are in
 * Settings -> Case desk, not here.
 */

export const DESK_TABS = [
  'upload',
  'mine',
  'queue',
  'tray',
  'companies',
  'overview',
] as const;

export type DeskTab = (typeof DESK_TABS)[number];

export const DEFAULT_DESK_TAB: DeskTab = 'upload';

/** Where the old admin "Desk codes" tab went. */
export const DESK_SETTINGS_HREF = '/settings?tab=case-desk';

/** The tabs a person sees; Overview is for team leaders and up. */
export function deskTabsFor(isLead: boolean): DeskTab[] {
  return DESK_TABS.filter((t) => t !== 'overview' || isLead);
}

/**
 * A raw `?tab=` as a tab this person may open. Unknown values, and tabs
 * they cannot see, fall back to the default (the server decides what they
 * may read; this only decides what is shown).
 */
export function resolveDeskTab(
  raw: string | null | undefined,
  isLead: boolean
): DeskTab {
  const tabs = deskTabsFor(isLead) as readonly string[];
  return tabs.includes(raw ?? '') ? (raw as DeskTab) : DEFAULT_DESK_TAB;
}

/** The `/desk` link for a tab (the default tab needs no parameter). */
export function deskTabHref(tab: DeskTab): string {
  return tab === DEFAULT_DESK_TAB ? '/desk' : `/desk?tab=${tab}`;
}

/** The old `?tab=codes` link now lives in Settings. */
export function legacyDeskRedirect(
  raw: string | null | undefined
): string | null {
  return raw === 'codes' ? DESK_SETTINGS_HREF : null;
}

/** The tab a worklist row opens; null where no tab fits. */
export function worklistTab(
  kind: 'tray' | 'queue' | 'mine' | 'tasks'
): DeskTab | null {
  if (kind === 'tasks') return null;
  return kind === 'tray' ? 'tray' : kind === 'queue' ? 'queue' : 'mine';
}

/** A tab's count badge text: nothing for none, '99+' above 99. */
export function badgeText(count: number | null | undefined): string | null {
  if (!count || count < 1 || !Number.isFinite(count)) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}
