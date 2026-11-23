/**
 * The Cases inbox's filters, search box and page URL as one value. Pure.
 *
 * The URL is shared state (saved views, Back, a pasted link), but a write
 * to it is seen by `useSearchParams` a moment later. `filters` is what
 * the person asked for last, so a second change made before the first
 * has landed builds on it instead of on a stale URL; `own` remembers the
 * writes still on their way, so one landing late is not mistaken for a
 * change made elsewhere (which would erase what is being typed).
 */
import { readSearchQuery } from './search';
import { CASES_TEAM_PARAM } from './team-view';
import { filterParams, filtersFromSearch, type InboxFilters } from './ui';

export interface InboxUrlState {
  /** The latest intended filters. */
  filters: InboxFilters;
  /** "My team" (`?team=1`). */
  team: boolean;
  /** The search box's text, maybe not committed yet. */
  draft: string;
  /** The query string last read from the URL. */
  seen: string;
  /** Query strings this screen wrote that have not been read back yet. */
  own: readonly string[];
}

const canonical = (search: string) => new URLSearchParams(search).toString();

function parse(search: string): { filters: InboxFilters; team: boolean } {
  const params = new URLSearchParams(search);
  return {
    filters: filtersFromSearch((k) => params.get(k)),
    team: params.get(CASES_TEAM_PARAM) === '1',
  };
}

export function initialInboxUrl(search: string): InboxUrlState {
  const seen = canonical(search);
  const { filters, team } = parse(seen);
  return { filters, team, draft: filters.q ?? '', seen, own: [] };
}

/** The query string that stands for a state ('' when nothing is set). */
export function inboxUrlSearch(
  s: Pick<InboxUrlState, 'filters' | 'team'>
): string {
  const qs = filterParams(s.filters);
  if (s.team) qs.set(CASES_TEAM_PARAM, '1');
  return qs.toString();
}

/** A keystroke in the search box. */
export function typeDraft(s: InboxUrlState, draft: string): InboxUrlState {
  return { ...s, draft };
}

/**
 * A filter change. One that does not name `q` takes the typed text along;
 * one that does (Clear, a saved view) replaces it. Naming the agent leaves
 * "My team" unless `team` says otherwise. Returns `s` itself when nothing
 * changed, so there is nothing to write.
 */
export function writeFilters(
  s: InboxUrlState,
  patch: Partial<InboxFilters>,
  team: boolean = s.team && !('agent' in patch)
): InboxUrlState {
  const named = 'q' in patch;
  const filters = {
    ...s.filters,
    q: readSearchQuery(s.draft),
    ...patch,
  };
  const draft = named ? (patch.q ?? '') : s.draft;
  const search = inboxUrlSearch({ filters, team });
  if (search === inboxUrlSearch(s))
    return draft === s.draft ? s : { ...s, draft };
  return { ...s, filters, team, draft, own: [...s.own, search] };
}

/** Commits the typed text (a pause, blur or Enter). */
export function commitDraft(s: InboxUrlState): InboxUrlState {
  return readSearchQuery(s.draft) === s.filters.q
    ? s
    : writeFilters(s, {}, s.team);
}

/**
 * Reads the URL back. Our own write landing (even a superseded one)
 * changes nothing; anything else is a change from outside and wins. The
 * box's text is replaced only when that change carries another `q` than
 * the one already committed.
 */
export function reconcileInboxUrl(
  s: InboxUrlState,
  search: string
): InboxUrlState {
  const seen = canonical(search);
  if (seen === s.seen) return s;
  const at = s.own.indexOf(seen);
  if (at !== -1) return { ...s, seen, own: s.own.slice(at + 1) };
  const { filters, team } = parse(seen);
  const draft = filters.q === s.filters.q ? s.draft : (filters.q ?? '');
  return { filters, team, draft, seen, own: [] };
}

/**
 * Forgets writes that never showed up one by one (React may render only
 * the last of several), so a later Back to one of them is not taken for
 * ours. Called once writes have had ample time to land.
 */
export function settleInboxUrl(s: InboxUrlState): InboxUrlState {
  return s.own.length === 0 ? s : { ...s, own: [] };
}
