import type { UnroutedNumber } from '@/lib/pbx/calls';

import { callsListScope, type CallsTab } from './call-ui';
import { missedWindowStart } from './timeline';

/** The most calls the Calls screen reads at once. */
export const CALLS_LIST_LIMIT = 200;
/** How often the list is read again while it is on screen. */
export const CALLS_REFRESH_MS = 60_000;
/** Focus and "shown again" arrive together, and a burst is one read. */
export const CALLS_REFRESH_GAP_MS = 3_000;

/** What orders the list: newest first, the id breaking a tie. */
export interface ListedCall {
  id: string;
  startedAt: string;
}

export interface CallsList<C> {
  calls: C[];
  /** Calls older than the last one exist. */
  truncated: boolean;
  /** Unrouted: the dialled numbers, summed over every such call. */
  numbers: UnroutedNumber[];
}

/**
 * What a Calls tab lists. Null for a tab that loads its own. A missed
 * call comes with its callback task (lib/pbx/missed-tasks.ts). `after`:
 * the page that continues past that call, as the API gave it.
 */
export async function loadCallsList<C>(
  tab: CallsTab,
  wide: boolean,
  now: number,
  getJson: (url: string) => Promise<unknown>,
  after?: ListedCall
): Promise<CallsList<C> | null> {
  const scope = callsListScope(tab, wide);
  if (!scope) return null;
  const q = new URLSearchParams({ scope, limit: String(CALLS_LIST_LIMIT) });
  if (tab === 'missed') q.set('from', missedWindowStart(now));
  if (after) {
    q.set('before', after.startedAt);
    q.set('beforeId', after.id);
  }
  const body = (await getJson(`/api/pbx/calls?${q}`)) as {
    calls?: C[];
    truncated?: boolean;
    numbers?: UnroutedNumber[];
  };
  return {
    calls: body.calls ?? [],
    truncated: body.truncated === true,
    numbers: body.numbers ?? [],
  };
}

/**
 * Newest first. The database keeps microseconds and a Date does not, so
 * two calls of one millisecond are told apart by their text.
 */
export function compareCalls(a: ListedCall, b: ListedCall): number {
  const ms = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (ms) return ms;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The first page read again, over a list whose older pages the reader
 * may have loaded: those stay. They go only when the two no longer meet
 * (a whole page of new calls arrived, so some between were not read), or
 * when the first page is already every call there is.
 */
export function refreshedList<C extends ListedCall>(
  shown: CallsList<C>,
  fresh: CallsList<C>
): CallsList<C> {
  const last = fresh.calls.at(-1);
  const first = shown.calls[0];
  if (!fresh.truncated || !last || !first || compareCalls(last, first) < 0)
    return fresh;
  const listed = new Set(fresh.calls.map((c) => c.id));
  const older = shown.calls.filter(
    (c) => !listed.has(c.id) && compareCalls(last, c) < 0
  );
  if (!older.length) return fresh;
  return {
    ...fresh,
    calls: [...fresh.calls, ...older],
    truncated: shown.truncated,
  };
}

/** One tab's list on screen, and what happened to its last reads. */
export interface ListView<C> {
  /** Which list: the tab and the Team / All toggle's side. */
  key: string;
  /** The read it came from; an earlier read's late answer is dropped. */
  seq: number;
  /** Null: never loaded, and the load failed. */
  list: CallsList<C> | null;
  /** The last refresh failed: what is shown may be behind. */
  stale: boolean;
  older: 'idle' | 'loading' | 'failed';
}

export type ListAction<C> =
  | { type: 'loaded'; key: string; seq: number; list: CallsList<C> }
  | { type: 'failed'; key: string; seq: number }
  | { type: 'olderStarted'; key: string }
  | { type: 'olderFailed'; key: string; after: string }
  | { type: 'older'; key: string; after: string; list: CallsList<C> };

/**
 * `seq` grows with every read of any tab, so a late answer of an earlier
 * tab or filter never replaces what a later read put there. An older
 * page joins only the list whose last call it continues.
 */
export function listReducer<C extends ListedCall>(
  view: ListView<C> | null,
  action: ListAction<C>
): ListView<C> | null {
  const same = view?.key === action.key ? view : null;
  switch (action.type) {
    case 'loaded':
      if (view && action.seq < view.seq) return view;
      return {
        key: action.key,
        seq: action.seq,
        list: same?.list
          ? refreshedList(same.list, action.list)
          : action.list,
        stale: false,
        older: same?.older ?? 'idle',
      };
    case 'failed':
      if (view && action.seq < view.seq) return view;
      return same?.list
        ? { ...same, seq: action.seq, stale: true }
        : {
            key: action.key,
            seq: action.seq,
            list: null,
            stale: false,
            older: 'idle',
          };
    case 'olderStarted':
      return same ? { ...same, older: 'loading' } : view;
    case 'olderFailed':
      return same ? { ...same, older: 'failed' } : view;
    case 'older': {
      if (!same?.list) return view;
      // A refresh started the list over: the page no longer meets it.
      if (same.list.calls.at(-1)?.id !== action.after)
        return { ...same, older: 'idle' };
      const listed = new Set(same.list.calls.map((c) => c.id));
      return {
        ...same,
        older: 'idle',
        list: {
          ...same.list,
          calls: [
            ...same.list.calls,
            ...action.list.calls.filter((c) => !listed.has(c.id)),
          ],
          truncated: action.list.truncated,
        },
      };
    }
  }
}

/** Whether one of the caller's live calls is no longer among them. */
export const callLeft = (before: readonly string[], now: readonly string[]) =>
  before.some((k) => !now.includes(k));

interface Listens {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/**
 * Reads the list again: when the window is focused or the tab is shown
 * after being hidden, every CALLS_REFRESH_MS while it is on screen (a
 * hidden tab asks nothing), and on `soon` (a call left the live ones;
 * the moment's wait lets its end be written). Reads stay
 * CALLS_REFRESH_GAP_MS apart.
 */
export function startCallsRefresh(
  run: () => void,
  doc: Listens & { hidden: boolean },
  win: Listens
): { soon: () => void; stop: () => void } {
  let last = Date.now();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const read = () => {
    clearTimeout(pending);
    pending = undefined;
    if (doc.hidden) return;
    last = Date.now();
    run();
  };
  const now = () => {
    if (!doc.hidden && Date.now() - last >= CALLS_REFRESH_GAP_MS) read();
  };
  const tick = setInterval(() => {
    if (Date.now() - last >= CALLS_REFRESH_MS - CALLS_REFRESH_GAP_MS) read();
  }, CALLS_REFRESH_MS);
  doc.addEventListener('visibilitychange', now);
  win.addEventListener('focus', now);
  return {
    soon: () => {
      clearTimeout(pending);
      pending = setTimeout(read, CALLS_REFRESH_GAP_MS);
    },
    stop: () => {
      clearTimeout(pending);
      clearInterval(tick);
      doc.removeEventListener('visibilitychange', now);
      win.removeEventListener('focus', now);
    },
  };
}
