/**
 * The bell's state, shared by the top bar's dropdown and the
 * /notifications page: one list, one realtime subscription, one count.
 *
 * The count is derived, never kept beside the list. `rows` is the
 * latest window (null until it is first loaded) plus the older pages
 * asked for, and `outsideUnread` counts the unread rows that are not in
 * it: all of them before the window loads (the head-count query), and
 * those older than the list after. So the badge is right with the
 * dropdown closed, and once the list is loaded, reading a row in it
 * moves the badge by exactly one.
 *
 * The list has no holes: from its first row to its last, every row the
 * reader has is in it, so "older" always means older than the last one.
 * A reload therefore asks for the whole depth again (`loadDepth`)
 * instead of merging a window into a list it may not reach.
 *
 * Pure, so the realtime and optimistic paths are tested without a
 * database or a DOM.
 */
import type { Notification } from '@/types';

export interface NotificationsState {
  rows: Notification[] | null;
  outsideUnread: number;
  /** There are rows older than the last one in `rows`. */
  hasOlder: boolean;
  /** How many older pages were added so far; only ever grows. */
  olderPages: number;
}

/** How many rows the first load, and each "Load older", brings. */
export const NOTIFICATIONS_PAGE = 100;

/**
 * The most a reload asks for: PostgREST answers at most 1000 rows
 * (max_rows), and one more than asked is read to know if there are older
 * ones. Deeper than this, a reload shortens the list.
 */
export const MAX_RELOAD = 900;

/** How many rows a reload asks for: what older pages added stays. */
export function loadDepth(state: NotificationsState): number {
  if (state.olderPages === 0 || !state.rows) return NOTIFICATIONS_PAGE;
  return Math.min(MAX_RELOAD, Math.max(NOTIFICATIONS_PAGE, state.rows.length));
}

/** `limit + 1` rows as read, as the page and whether older ones follow. */
export function pageOf(read: Notification[], limit: number) {
  return { rows: read.slice(0, limit), hasOlder: read.length > limit };
}

/**
 * The row "Load older" continues from, or null when there is nothing
 * older. The last one in the list, not the one with the oldest time: an
 * event's row is put at the front whatever its time, and continuing from
 * there would skip rows.
 */
export function olderCursor(state: NotificationsState): Notification | null {
  return (state.hasOlder && state.rows?.at(-1)) || null;
}

/**
 * The PostgREST `or` filter for the rows after `row` in the list's order
 * (created_at, id, both descending). The time is the row's own string:
 * a JS Date would cut the database's microseconds and skip rows.
 */
export function olderThan(row: { created_at: string; id: string }): string {
  return `created_at.lt."${row.created_at}",and(created_at.eq."${row.created_at}",id.lt.${row.id})`;
}

/** The digits below a millisecond, which a JS Date cuts off. */
const belowMs = (at: string) =>
  Number((/\.(\d+)/.exec(at)?.[1] ?? '').padEnd(6, '0').slice(3, 6));

/** Two database times, to the microsecond; negative when `a` is earlier. */
export function compareTimes(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b) || belowMs(a) - belowMs(b);
}

/**
 * What "Mark all as read" covers: everything up to the newest row in the
 * list, so a row that arrives meanwhile, or was never shown, stays
 * unread. Null when there is nothing to mark, or no list on screen yet.
 */
export function markAllBound(state: NotificationsState): string | null {
  if (!state.rows?.length || unreadCount(state) === 0) return null;
  return state.rows
    .map((n) => n.created_at)
    .reduce((a, b) => (compareTimes(a, b) < 0 ? b : a));
}

export type NotificationsAction =
  /** The head count of unread rows, before any window is loaded. */
  | { type: 'count'; unread: number }
  /**
   * The newest rows, with the unread total counted at the same time, and
   * the `olderPages` of the state that asked.
   */
  | {
      type: 'loaded';
      rows: Notification[];
      hasOlder: boolean;
      unreadTotal: number;
      olderPages: number;
    }
  /** The rows older than `after`, the last row when they were asked for. */
  | {
      type: 'olderLoaded';
      after: string;
      rows: Notification[];
      hasOlder: boolean;
    }
  | { type: 'insert'; row: Notification }
  | { type: 'update'; row: Notification }
  | { type: 'delete'; row: Partial<Notification> }
  | { type: 'markRead'; id: string; at: string }
  /** Every row up to `upTo` (markAllBound), listed or older. */
  | { type: 'markAllRead'; at: string; upTo: string };

/** One realtime event on the reader's rows. A DELETE carries only the key. */
export type NotificationChange = Extract<
  NotificationsAction,
  { type: 'insert' | 'update' | 'delete' }
>;

/** A realtime payload as the action that applies it. */
export function changeFromPayload(payload: {
  eventType: string;
  new: unknown;
  old: unknown;
}): NotificationChange | null {
  switch (payload.eventType) {
    case 'INSERT':
      return { type: 'insert', row: payload.new as Notification };
    case 'UPDATE':
      return { type: 'update', row: payload.new as Notification };
    case 'DELETE':
      return { type: 'delete', row: payload.old as Partial<Notification> };
    default:
      return null;
  }
}

export const INITIAL_NOTIFICATIONS_STATE: NotificationsState = {
  rows: null,
  outsideUnread: 0,
  hasOlder: false,
  olderPages: 0,
};

const unreadIn = (rows: readonly Notification[]) =>
  rows.reduce((n, row) => (row.read_at ? n : n + 1), 0);

/** Every unread row the reader has, in the window or not. */
export function unreadCount(state: NotificationsState): number {
  return (state.rows ? unreadIn(state.rows) : 0) + state.outsideUnread;
}

export function notificationsReducer(
  state: NotificationsState,
  action: NotificationsAction
): NotificationsState {
  switch (action.type) {
    case 'count':
      // A window already counts its own rows; this is the pre-load figure.
      if (state.rows) return state;
      return { ...state, outsideUnread: Math.max(0, action.unread) };
    case 'loaded': {
      let { rows, hasOlder } = action;
      // An older page landed while this was being read: keep it.
      const last = rows.at(-1);
      if (last && state.rows && action.olderPages !== state.olderPages) {
        const at = state.rows.findIndex((n) => n.id === last.id);
        if (at !== -1) {
          rows = [...rows, ...state.rows.slice(at + 1)];
          hasOlder = state.hasOlder;
        }
      }
      return {
        ...state,
        rows,
        hasOlder,
        // Counted by two requests, so a row that landed between them
        // could make this negative.
        outsideUnread: Math.max(0, action.unreadTotal - unreadIn(rows)),
      };
    }
    case 'olderLoaded': {
      // The list's end moved since: these rows may not continue it.
      if (!state.rows || state.rows.at(-1)?.id !== action.after) return state;
      const held = new Set(state.rows.map((n) => n.id));
      const added = action.rows.filter((n) => !held.has(n.id));
      return {
        rows: [...state.rows, ...added],
        outsideUnread: Math.max(0, state.outsideUnread - unreadIn(added)),
        hasOlder: action.hasOlder,
        olderPages: state.olderPages + 1,
      };
    }
    case 'insert': {
      const { row } = action;
      if (!state.rows) {
        return row.read_at
          ? state
          : { ...state, outsideUnread: state.outsideUnread + 1 };
      }
      if (state.rows.some((n) => n.id === row.id)) return state;
      return { ...state, rows: [row, ...state.rows] };
    }
    case 'update': {
      const { row } = action;
      if (state.rows?.some((n) => n.id === row.id)) {
        return {
          ...state,
          rows: state.rows.map((n) => (n.id === row.id ? { ...n, ...row } : n)),
        };
      }
      // Outside the window. Updates here only ever set read_at (marking
      // a notification read). Derive purely from the new row so we don't
      // rely on payload.old columns, which require REPLICA IDENTITY FULL.
      return row.read_at
        ? { ...state, outsideUnread: Math.max(0, state.outsideUnread - 1) }
        : state;
    }
    case 'delete': {
      const { row } = action;
      if (state.rows?.some((n) => n.id === row.id)) {
        return { ...state, rows: state.rows.filter((n) => n.id !== row.id) };
      }
      // payload.old carries only the key without REPLICA IDENTITY FULL,
      // so a row outside the window is taken to have been unread.
      return row.read_at
        ? state
        : { ...state, outsideUnread: Math.max(0, state.outsideUnread - 1) };
    }
    case 'markRead':
      if (!state.rows) return state;
      return {
        ...state,
        rows: state.rows.map((n) =>
          n.id === action.id && !n.read_at ? { ...n, read_at: action.at } : n
        ),
      };
    case 'markAllRead':
      // The request covers every row up to `upTo`, so the ones older than
      // the list are read too; a row newer than that is not.
      return {
        ...state,
        rows:
          state.rows?.map((n) =>
            n.read_at || compareTimes(n.created_at, action.upTo) > 0
              ? n
              : { ...n, read_at: action.at }
          ) ?? null,
        outsideUnread: 0,
      };
  }
}
