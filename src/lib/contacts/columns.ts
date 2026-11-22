/**
 * Which optional Contacts columns are shown. Name and phone are fixed;
 * the rest can be hidden by hand, or automatically when no loaded row
 * has a value for them ("Hide empty columns"). Persisted per user in
 * localStorage by the page; this module is pure.
 */

export const OPTIONAL_COLUMNS = [
  'email',
  'company',
  'chatTag',
  'source',
  'owner',
  'assignedTo',
  'createdAt',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export interface ColumnPrefs {
  hidden: OptionalColumn[];
  hideEmpty: boolean;
}

export const DEFAULT_COLUMN_PREFS: ColumnPrefs = {
  hidden: [],
  hideEmpty: false,
};

/** Whether a row has a value for each optional column. */
export type ColumnPresence = Partial<Record<OptionalColumn, boolean>>;

export function isOptionalColumn(value: unknown): value is OptionalColumn {
  return (
    typeof value === 'string' &&
    (OPTIONAL_COLUMNS as readonly string[]).includes(value)
  );
}

/** Unknown keys are dropped and bad shapes fall back to the default. */
export function parseColumnPrefs(raw: unknown): ColumnPrefs {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return DEFAULT_COLUMN_PREFS;
    }
  }
  if (!data || typeof data !== 'object') return DEFAULT_COLUMN_PREFS;
  const d = data as Record<string, unknown>;
  const hidden = Array.isArray(d.hidden)
    ? [...new Set(d.hidden.filter(isOptionalColumn))]
    : [];
  return { hidden, hideEmpty: d.hideEmpty === true };
}

export function serializeColumnPrefs(prefs: ColumnPrefs): string {
  return JSON.stringify({ hidden: prefs.hidden, hideEmpty: prefs.hideEmpty });
}

export function toggleHidden(
  prefs: ColumnPrefs,
  column: OptionalColumn
): ColumnPrefs {
  return {
    ...prefs,
    hidden: prefs.hidden.includes(column)
      ? prefs.hidden.filter((c) => c !== column)
      : [...prefs.hidden, column],
  };
}

/**
 * The optional columns to show: not hidden by hand and, with
 * `hideEmpty`, having a value in at least one loaded row. With no rows
 * loaded nothing is "empty" (a loading or empty list keeps its header).
 */
export function visibleColumns(
  prefs: ColumnPrefs,
  rows: readonly ColumnPresence[]
): Set<OptionalColumn> {
  const out = new Set<OptionalColumn>();
  for (const column of OPTIONAL_COLUMNS) {
    if (prefs.hidden.includes(column)) continue;
    if (
      prefs.hideEmpty &&
      rows.length > 0 &&
      !rows.some((row) => row[column] === true)
    ) {
      continue;
    }
    out.add(column);
  }
  return out;
}

/** localStorage key, one per user. */
export function columnPrefsKey(userId: string | null | undefined): string {
  return `taamul.contacts.columns.v1:${userId ?? 'anon'}`;
}
