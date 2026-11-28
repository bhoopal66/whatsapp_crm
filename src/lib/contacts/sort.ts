/**
 * Contacts list sorting. Every key orders the WHOLE filtered match set,
 * never just the loaded page, so pagination stays correct:
 *
 * - `name` and `created` are columns of `contacts`: the order is applied
 *   in the PostgREST query (or over the chat-tag filter's match set,
 *   `compareContactRows`).
 * - `owner`, `assignee` and `activity` are not: the owner's and the
 *   assigned person's names live on profiles, and the assignee and the
 *   last message on the contact's company chat, a to-many embed
 *   PostgREST cannot order contacts by. Those keys are ordered by the
 *   `contacts_sorted_page` RPC (migration 257, SECURITY INVOKER, so RLS
 *   decides), which returns one page of ids (`SERVER_SORT_KEYS`).
 *   Without that RPC the list falls back to the default order
 *   (`effectiveContactSort`).
 *
 * Names sort case-insensitively, blanks and missing values go last in
 * both directions, and ties fall back to created_at newest first, then
 * id, in SQL and here alike.
 */

export const CONTACT_SORT_KEYS = [
  'name',
  'created',
  'owner',
  'assignee',
  'activity',
] as const;
export type ContactSortKey = (typeof CONTACT_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

/** Keys only migration 257's `contacts_sorted_page` can order by. */
export const SERVER_SORT_KEYS = ['owner', 'assignee', 'activity'] as const;
export type ServerSortKey = (typeof SERVER_SORT_KEYS)[number];

export function isServerSortKey(key: string): key is ServerSortKey {
  return (SERVER_SORT_KEYS as readonly string[]).includes(key);
}

export interface ContactSort {
  sort: ContactSortKey;
  dir: SortDir;
}

/** The list's historical order: newest first. */
export const DEFAULT_CONTACT_SORT: ContactSort = {
  sort: 'created',
  dir: 'desc',
};

/** Direction a key starts in when first picked: dates newest first. */
export function defaultDir(key: ContactSortKey): SortDir {
  return key === 'created' || key === 'activity' ? 'desc' : 'asc';
}

/**
 * The order the list can actually apply: a server-only key falls back
 * to the default while the RPC is missing (migration 257 not applied).
 */
export function effectiveContactSort(
  s: ContactSort,
  serverSortAvailable: boolean
): ContactSort {
  return isServerSortKey(s.sort) && !serverSortAvailable
    ? DEFAULT_CONTACT_SORT
    : s;
}

/** Unknown / old values fall back to the default, never throw. */
export function parseContactSort(
  sort: string | null | undefined,
  dir: string | null | undefined
): ContactSort {
  const key = CONTACT_SORT_KEYS.find((k) => k === sort);
  if (!key) return DEFAULT_CONTACT_SORT;
  return {
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : defaultDir(key),
  };
}

/** Header click: same key flips direction, a new key starts at its default. */
export function nextContactSort(
  current: ContactSort,
  key: ContactSortKey
): ContactSort {
  if (current.sort === key) {
    return { sort: key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { sort: key, dir: defaultDir(key) };
}

export function isDefaultSort(s: ContactSort): boolean {
  return (
    s.sort === DEFAULT_CONTACT_SORT.sort && s.dir === DEFAULT_CONTACT_SORT.dir
  );
}

export function ariaSortFor(
  current: ContactSort,
  key: ContactSortKey
): 'ascending' | 'descending' | 'none' {
  if (current.sort !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

/**
 * The compact sort control shown on a phone, where the column headers
 * past Name are hidden (below `lg`). The keys it offers: Name always,
 * the others only when their column is switched on, in header order.
 */
export function mobileSortKeys(visible: {
  owner: boolean;
  assignee: boolean;
  activity: boolean;
  created: boolean;
}): ContactSortKey[] {
  const keys: ContactSortKey[] = ['name'];
  if (visible.owner) keys.push('owner');
  if (visible.assignee) keys.push('assignee');
  if (visible.activity) keys.push('activity');
  if (visible.created) keys.push('created');
  return keys;
}

/** Picking a key in the phone control: the same key changes nothing, a new one starts at its default direction. */
export function pickContactSortKey(
  current: ContactSort,
  key: ContactSortKey
): ContactSort {
  return current.sort === key ? current : { sort: key, dir: defaultDir(key) };
}

/** The phone control's direction button: same key, opposite direction. */
export function flipContactSortDir(current: ContactSort): ContactSort {
  return { sort: current.sort, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/** `sort` / `dir` URL params; the default is omitted. */
export function sortToParams(s: ContactSort): Record<string, string> {
  return isDefaultSort(s) ? {} : { sort: s.sort, dir: s.dir };
}

type RowKeys = { id: string; created_at: string; name?: string | null };

/**
 * Order matched rows (the chat-tag filter reads every match) the way
 * the plain query orders: sort key, then created_at newest first, then
 * id, so pages never overlap. Empty names go last in both directions.
 * A server-only key (owner, assignee, activity) is never ordered here:
 * the RPC orders it, and its fallback is the default order, which is
 * what this applies for one.
 */
export function compareContactRows(sort: ContactSort) {
  const s = isServerSortKey(sort.sort) ? DEFAULT_CONTACT_SORT : sort;
  const sign = s.dir === 'asc' ? 1 : -1;
  return (a: RowKeys, b: RowKeys): number => {
    if (s.sort === 'name') {
      const an = (a.name ?? '').trim();
      const bn = (b.name ?? '').trim();
      if (an !== bn) {
        if (!an) return 1;
        if (!bn) return -1;
        const c = an.localeCompare(bn, 'en', { sensitivity: 'base' });
        if (c !== 0) return c * sign;
      }
    } else if (a.created_at !== b.created_at) {
      return (a.created_at < b.created_at ? -1 : 1) * sign;
    }
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };
}
