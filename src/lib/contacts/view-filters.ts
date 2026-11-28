/**
 * The Contacts list's filter state as one serialisable object, for saved
 * views. `fromViewFilters` accepts anything (an old saved row, a key a
 * later build added, hand-edited JSON) and returns a valid object;
 * unknown keys are dropped and bad values fall back to the defaults.
 */

import { isOptionalColumn, type OptionalColumn } from '@/lib/contacts/columns';
import {
  parseSourceFilter,
  type SourceFilterValue,
} from '@/lib/contacts/lead-source';
import {
  DEFAULT_CONTACT_SORT,
  parseContactSort,
  type ContactSortKey,
  type SortDir,
} from '@/lib/contacts/sort';

export interface ContactsViewFilters {
  search: string;
  chatTagIds: string[];
  sources: SourceFilterValue[];
  sort: ContactSortKey;
  dir: SortDir;
  /** Absent = leave the user's column choice alone. */
  hiddenColumns?: OptionalColumn[];
  /**
   * Informational: the list was narrowed to the viewer's own contacts
   * (a team leader on /contacts). Scope is role-derived, so applying a
   * view never changes it.
   */
  personalOnly?: boolean;
}

/** What the page holds; `toViewFilters` copies out of it. */
export interface ContactsViewState {
  search: string;
  chatTagIds: readonly string[];
  sources: readonly string[];
  sort: { sort: ContactSortKey; dir: SortDir };
  hiddenColumns?: readonly OptionalColumn[];
  personalOnly?: boolean;
}

const MAX_SEARCH = 200;
const MAX_TAG_IDS = 100;

export const EMPTY_VIEW_FILTERS: ContactsViewFilters = {
  search: '',
  chatTagIds: [],
  sources: [],
  sort: DEFAULT_CONTACT_SORT.sort,
  dir: DEFAULT_CONTACT_SORT.dir,
};

export function toViewFilters(state: ContactsViewState): ContactsViewFilters {
  const out: ContactsViewFilters = {
    search: state.search.trim(),
    chatTagIds: [...new Set(state.chatTagIds)].sort(),
    sources: parseSourceFilter(state.sources),
    sort: state.sort.sort,
    dir: state.sort.dir,
  };
  if (state.hiddenColumns) out.hiddenColumns = [...state.hiddenColumns];
  if (state.personalOnly !== undefined) out.personalOnly = state.personalOnly;
  return out;
}

export function fromViewFilters(raw: unknown): ContactsViewFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_VIEW_FILTERS };
  }
  const o = raw as Record<string, unknown>;
  const sort = parseContactSort(
    typeof o.sort === 'string' ? o.sort : null,
    typeof o.dir === 'string' ? o.dir : null
  );
  const out: ContactsViewFilters = {
    search:
      typeof o.search === 'string' ? o.search.trim().slice(0, MAX_SEARCH) : '',
    chatTagIds: Array.isArray(o.chatTagIds)
      ? [
          ...new Set(
            o.chatTagIds.filter(
              (id): id is string => typeof id === 'string' && id.length > 0
            )
          ),
        ].slice(0, MAX_TAG_IDS)
      : [],
    sources: parseSourceFilter(
      Array.isArray(o.sources) ? (o.sources as unknown[]) : null
    ),
    sort: sort.sort,
    dir: sort.dir,
  };
  if (Array.isArray(o.hiddenColumns)) {
    out.hiddenColumns = [...new Set(o.hiddenColumns.filter(isOptionalColumn))];
  }
  if (typeof o.personalOnly === 'boolean') out.personalOnly = o.personalOnly;
  return out;
}

/** Two views that mean the same thing (for "view has unsaved changes"). */
export function sameViewFilters(
  a: ContactsViewFilters,
  b: ContactsViewFilters
): boolean {
  const norm = (f: ContactsViewFilters) =>
    JSON.stringify([
      f.search,
      [...f.chatTagIds].sort(),
      f.sources,
      f.sort,
      f.dir,
      f.hiddenColumns ? [...f.hiddenColumns].sort() : null,
    ]);
  return norm(a) === norm(b);
}
