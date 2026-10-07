import type { CsvContactRow } from '@/lib/broadcasts/variables';

/**
 * A broadcast audience drawn from `compass_contacts` (migration 056) —
 * the customers Taamul Compass syncs, which are deliberately kept out of
 * `contacts`. The wizard picks a slice of them ("100 numbers from the
 * bottom of the list"); the send path reads that slice and hands it to
 * the CSV pipeline (`upsertCsvContacts`), because a recipient has to be
 * a real `contacts` row and the CSV path already dedupes and creates
 * them. Everything here is pure so the slice arithmetic is tested.
 */

/**
 * How the slice is ordered before it is cut. "The Compass list" is the
 * Compass screen, which lists `updated_at DESC, id DESC` — so its top
 * is the most recently updated customer and its bottom the least.
 */
export type CompassOrder =
  | 'list_top'
  | 'list_bottom'
  | 'newest_added'
  | 'oldest_added'
  | 'name_az'
  | 'name_za';

export const COMPASS_ORDERS: readonly CompassOrder[] = [
  'list_top',
  'list_bottom',
  'newest_added',
  'oldest_added',
  'name_az',
  'name_za',
];

export interface CompassOrderSpec {
  column: 'updated_at' | 'created_at' | 'name';
  ascending: boolean;
}

const ORDER_SPECS: Record<CompassOrder, CompassOrderSpec> = {
  list_top: { column: 'updated_at', ascending: false },
  list_bottom: { column: 'updated_at', ascending: true },
  newest_added: { column: 'created_at', ascending: false },
  oldest_added: { column: 'created_at', ascending: true },
  name_az: { column: 'name', ascending: true },
  name_za: { column: 'name', ascending: false },
};

/**
 * The ORDER BY for a selection. Callers add `id` in the same direction
 * as a tiebreak: offsets into a non-unique order would let a row appear
 * on two pages, or on none.
 */
export function compassOrderSpec(order: CompassOrder): CompassOrderSpec {
  return ORDER_SPECS[order];
}

/**
 * Which slice of the ordered list: rows `[offset, offset + limit)`,
 * counted over customers that have a phone. `limit: null` = everything
 * from `offset` on.
 */
export interface CompassSelection {
  order: CompassOrder;
  offset: number;
  limit: number | null;
}

export const DEFAULT_COMPASS_SELECTION: CompassSelection = {
  order: 'list_top',
  offset: 0,
  limit: null,
};

function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Clamp a selection from the UI (or a stored `audience_filter`) to
 * something the query can use: a known order, a non-negative integer
 * offset, and a positive integer limit or null. A limit of 0 is null,
 * because the wizard's "how many" field reads blank/0 as "all".
 */
export function normalizeCompassSelection(
  input: Partial<CompassSelection> | null | undefined
): CompassSelection {
  const order = COMPASS_ORDERS.includes(input?.order as CompassOrder)
    ? (input!.order as CompassOrder)
    : DEFAULT_COMPASS_SELECTION.order;
  const limit = toCount(input?.limit);
  return {
    order,
    offset: toCount(input?.offset),
    limit: limit > 0 ? limit : null,
  };
}

/** How many rows the slice holds when `total` rows match. */
export function compassWindowSize(
  selection: CompassSelection,
  total: number
): number {
  const available = Math.max(0, total - selection.offset);
  return selection.limit === null
    ? available
    : Math.min(selection.limit, available);
}

/**
 * The next `.range(from, to)` (inclusive) to read once `fetched` rows of
 * the slice are in hand, or null when the limit is reached. Reaching the
 * end of the table is the caller's job: like `fetchAllPages`, it stops
 * on an EMPTY page, never a short one — PostgREST answers every page
 * short when its `max-rows` is below `pageSize`.
 */
export function compassWindowPage(
  selection: CompassSelection,
  fetched: number,
  pageSize: number
): { from: number; to: number } | null {
  const remaining =
    selection.limit === null ? pageSize : selection.limit - fetched;
  const size = Math.min(pageSize, remaining);
  if (size <= 0) return null;
  const from = selection.offset + fetched;
  return { from, to: from + size - 1 };
}

/** The `compass_contacts` columns an audience reads. */
export const COMPASS_AUDIENCE_COLUMNS =
  'compass_id, name, phone, email, company, attributes';

export interface CompassAudienceRow {
  compass_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  attributes: Record<string, unknown> | null;
}

/**
 * The fields every Compass row offers as a variable source, in the
 * order the personalize step lists them. An `attributes` key with the
 * same name never shadows these.
 */
export const COMPASS_BUILTIN_COLUMNS = [
  'name',
  'phone',
  'email',
  'company',
  'compass_id',
] as const;

const BUILTIN_SET = new Set<string>(COMPASS_BUILTIN_COLUMNS);

/**
 * A cell as text: strings as they are, numbers and booleans printed,
 * objects and arrays as JSON (an ERP field can be nested, and dropping
 * it would leave the admin wondering why it is missing). null/undefined
 * are absent, so a variable mapped to them falls back like a missing
 * CSV cell.
 */
function cellText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * One Compass row as the CSV pipeline's row: `phone`/`name`/`company`
 * feed the contact upsert, and `values` — keyed like CSV headers,
 * lower-cased — is what a `csv_column` mapping reads, so a template
 * variable can take any ERP attribute.
 */
export function compassRowToCsvRow(row: CompassAudienceRow): CsvContactRow {
  const values: Record<string, string> = {};
  const builtins: Record<(typeof COMPASS_BUILTIN_COLUMNS)[number], unknown> = {
    name: row.name,
    phone: row.phone,
    email: row.email,
    company: row.company,
    compass_id: row.compass_id,
  };
  for (const key of COMPASS_BUILTIN_COLUMNS) {
    const text = cellText(builtins[key]);
    if (text !== undefined) values[key] = text;
  }
  const attributes =
    row.attributes && typeof row.attributes === 'object' ? row.attributes : {};
  for (const [rawKey, value] of Object.entries(attributes)) {
    const key = rawKey.trim().toLowerCase();
    // Built-ins win, and so does the first spelling of a key that
    // differs only in case.
    if (!key || BUILTIN_SET.has(key) || key in values) continue;
    const text = cellText(value);
    if (text !== undefined) values[key] = text;
  }
  return {
    phone: row.phone ?? '',
    name: row.name ?? undefined,
    company: row.company ?? undefined,
    values,
  };
}

/**
 * The columns the personalize step offers: the built-ins always (so
 * "email" is there even when the sample has none), then every other key
 * seen in the rows, sorted.
 */
export function compassColumns(rows: CsvContactRow[]): string[] {
  const extra = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.values ?? {})) {
      if (!BUILTIN_SET.has(key)) extra.add(key);
    }
  }
  return [...COMPASS_BUILTIN_COLUMNS, ...[...extra].sort()];
}
