/**
 * Saved views (migration 250): a named filter set for one screen. The
 * database stores `filters` as an opaque JSON object; each screen owns
 * its own shape and must read it back defensively (`parse*`), because a
 * view can outlive the code that wrote it.
 */
export const VIEW_SCREENS = ['inbox', 'contacts'] as const;
export type ViewScreen = (typeof VIEW_SCREENS)[number];

export const VIEW_NAME_MAX = 60;

export interface SavedView {
  id: string;
  screen: ViewScreen;
  name: string;
  shared: boolean;
  ownerId: string;
  filters: Record<string, unknown>;
  updatedAt: string;
}

/** Row as PostgREST returns it. */
export interface SavedViewRow {
  id: string;
  screen: string;
  name: string;
  shared: boolean;
  owner_user_id: string;
  filters: unknown;
  updated_at: string;
}

export function toSavedView(row: SavedViewRow): SavedView | null {
  if (!(VIEW_SCREENS as readonly string[]).includes(row.screen)) return null;
  const filters =
    row.filters &&
    typeof row.filters === 'object' &&
    !Array.isArray(row.filters)
      ? (row.filters as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    screen: row.screen as ViewScreen,
    name: row.name,
    shared: row.shared === true,
    ownerId: row.owner_user_id,
    filters,
    updatedAt: row.updated_at,
  };
}

/** Trimmed name, or null when blank / too long. */
export function cleanViewName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > VIEW_NAME_MAX) return null;
  return name;
}

/** Personal first, then shared; each by name. */
export function sortViews(views: readonly SavedView[], me: string | null) {
  const mine = (v: SavedView) => (v.ownerId === me ? 0 : 1);
  return [...views].sort(
    (a, b) =>
      Number(a.shared) - Number(b.shared) ||
      mine(a) - mine(b) ||
      a.name.localeCompare(b.name)
  );
}

/** Who may change or delete this view in the UI (RLS decides for real). */
export function canChangeView(
  view: SavedView,
  me: string | null,
  isAdmin: boolean
) {
  return view.ownerId === me || (view.shared && isAdmin);
}

/**
 * What a shared view may carry. The search text is a customer's name or
 * phone, readable workspace-wide once shared, and the column choice is
 * the viewer's own: both are left out (the search blanked, not dropped,
 * so applying it clears the viewer's box rather than keeping theirs).
 */
export function sharedViewFilters(
  filters: Record<string, unknown>
): Record<string, unknown> {
  const { hiddenColumns: _columns, ...rest } = filters;
  void _columns;
  if ('search' in rest) rest.search = '';
  return rest;
}

/**
 * A view's chat tag ids split by whether the tag still exists. A view
 * whose tags were all deleted must not widen to "everything".
 */
export function splitKnownTags(
  ids: readonly string[],
  known: (id: string) => boolean
): { kept: string[]; missing: number } {
  const kept = ids.filter(known);
  return { kept, missing: ids.length - kept.length };
}
