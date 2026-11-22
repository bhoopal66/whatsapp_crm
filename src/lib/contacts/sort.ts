/**
 * Contacts list sorting. Only keys the database can order a PAGE by are
 * offered: `name` and `created` are columns of `contacts`, so the order
 * is applied in the query (or over the whole filtered match set) and
 * pagination stays correct.
 *
 * Owner, Assigned to and Last activity are deliberately NOT sortable:
 * owner/assignee are uuids (ordering them is not ordering by name) and
 * the assignee and last message live on `conversations`, a to-many
 * embed PostgREST cannot order the parent rows by. Sorting only the 25
 * loaded rows would look like a sort and be wrong, so it is not offered.
 */

export const CONTACT_SORT_KEYS = ['name', 'created'] as const;
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
  return key === 'created' ? 'desc' : 'asc';
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
