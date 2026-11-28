/**
 * Contacts list sorting. `name` and `created` are columns of `contacts`,
 * so the order is applied in the query (or over the whole filtered match
 * set). `owner`, `assigned` and `activity` live in other tables
 * (profiles, conversations), which PostgREST cannot order contacts by,
 * so they go through the `contacts_sorted_page` function (migration
 * 322) that returns one correctly ordered page; see `usesSortedPage`.
 */

export const CONTACT_SORT_KEYS = [
  'name',
  'created',
  'owner',
  'assigned',
  'activity',
] as const;
export type ContactSortKey = (typeof CONTACT_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface ContactSort {
  sort: ContactSortKey;
  dir: SortDir;
}

/** The list's historical order: newest first. */
export const DEFAULT_CONTACT_SORT: ContactSort = {
  sort: 'created',
  dir: 'desc',
};

/** Direction a key starts in when first picked. */
export function defaultDir(key: ContactSortKey): SortDir {
  return key === 'created' || key === 'activity' ? 'desc' : 'asc';
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

/** Keys ordered by `contacts_sorted_page` (a value in another table). */
export type SortedPageKey = 'owner' | 'assigned' | 'activity';

export function usesSortedPage(key: ContactSortKey): key is SortedPageKey {
  return key === 'owner' || key === 'assigned' || key === 'activity';
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

/** `sort` / `dir` URL params; the default is omitted. */
export function sortToParams(s: ContactSort): Record<string, string> {
  return isDefaultSort(s) ? {} : { sort: s.sort, dir: s.dir };
}

type RowKeys = { id: string; created_at: string; name?: string | null };

/**
 * Order matched rows (the chat-tag filter reads every match) the way
 * the plain query orders: sort key, then created_at newest first, then
 * id, so pages never overlap. Empty names go last in both directions.
 */
export function compareContactRows(s: ContactSort) {
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
