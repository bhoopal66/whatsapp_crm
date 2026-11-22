/**
 * Which sidebar groups a person has folded away.
 *
 * Pure helpers: the sidebar owns the React state, this owns the rules
 * and the (fallible) localStorage round trip. Storage is a convenience
 * only. It can be missing, full, blocked or hold junk, so every access
 * is wrapped and a failure means "nothing collapsed", never an error.
 *
 * Two rules the UI relies on:
 * - the group that holds the current page is always open, whatever was
 *   saved, so the highlighted row is never hidden;
 * - the key names the user, so two people on one browser (or a sign-out
 *   and sign-in) never inherit each other's folds.
 */

/** The slice of `Storage` the helpers use (a test passes a fake). */
export interface NavStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = 'wacrm.nav.collapsed';

/** localStorage key for one person's folded groups. */
export function navCollapseKey(userId: string | null | undefined): string {
  return `${KEY_PREFIX}:${userId ?? 'anonymous'}`;
}

/** Parse a stored value into a de-duplicated list of group ids. */
export function parseCollapsed(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(value.filter((v): v is string => typeof v === 'string')),
    ];
  } catch {
    return [];
  }
}

/** Flip one group in or out of the folded list (returns a new list). */
export function toggleCollapsed(
  collapsed: readonly string[],
  groupId: string
): string[] {
  return collapsed.includes(groupId)
    ? collapsed.filter((id) => id !== groupId)
    : [...collapsed, groupId];
}

/**
 * The id of the group whose row matches the current page, or null. The
 * first group with a matching row wins; `isActive` is the sidebar's own
 * row test, so a sub-page lights its parent's group too.
 */
export function activeGroupId(
  groups: ReadonlyArray<{ id: string; items: ReadonlyArray<{ href: string }> }>,
  isActive: (href: string) => boolean
): string | null {
  for (const group of groups) {
    if (group.items.some((item) => isActive(item.href))) return group.id;
  }
  return null;
}

/** Is `groupId` shown open? The active group is always open. */
export function isGroupOpen(
  groupId: string,
  collapsed: readonly string[],
  activeId: string | null
): boolean {
  return groupId === activeId || !collapsed.includes(groupId);
}

/** Read the saved folds; any storage problem reads as none. */
export function readCollapsed(
  storage: NavStorage | null | undefined,
  userId: string | null | undefined
): string[] {
  try {
    if (!storage) return [];
    return parseCollapsed(storage.getItem(navCollapseKey(userId)));
  } catch {
    return [];
  }
}

/** Save the folds; returns false when storage refused (callers ignore it). */
export function writeCollapsed(
  storage: NavStorage | null | undefined,
  userId: string | null | undefined,
  collapsed: readonly string[]
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(navCollapseKey(userId), JSON.stringify(collapsed));
    return true;
  } catch {
    return false;
  }
}

/** `window.localStorage`, or null where the accessor throws or is absent. */
export function browserNavStorage(): NavStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
