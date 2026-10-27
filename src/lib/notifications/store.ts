/**
 * The bell's state, shared by the top bar's dropdown and the
 * /notifications page: one list, one realtime subscription, one count.
 *
 * The count is derived, never kept beside the list. `rows` is the
 * latest window (null until it is first loaded), and `outsideUnread`
 * counts the unread rows that are not in it: all of them before the
 * window loads (the head-count query), and those older than the window
 * after. So the badge is right with the dropdown closed, and once the
 * list is loaded, reading a row in it moves the badge by exactly one.
 *
 * Pure, so the realtime and optimistic paths are tested without a
 * database or a DOM.
 */
import type { Notification } from '@/types';

export interface NotificationsState {
  rows: Notification[] | null;
  outsideUnread: number;
}

export type NotificationsAction =
  /** The head count of unread rows, before any window is loaded. */
  | { type: 'count'; unread: number }
  /** A window, with the unread total counted at the same time. */
  | { type: 'loaded'; rows: Notification[]; unreadTotal: number }
  | { type: 'insert'; row: Notification }
  | { type: 'update'; row: Notification }
  | { type: 'delete'; row: Partial<Notification> }
  | { type: 'markRead'; id: string; at: string }
  | { type: 'markAllRead'; at: string };

export const INITIAL_NOTIFICATIONS_STATE: NotificationsState = {
  rows: null,
  outsideUnread: 0,
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
    case 'loaded':
      return {
        rows: action.rows,
        // Counted by two requests, so a row that landed between them
        // could make this negative.
        outsideUnread: Math.max(0, action.unreadTotal - unreadIn(action.rows)),
      };
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
      // The request is unfiltered (every unread row RLS shows), so the
      // rows outside the window are read too.
      return {
        rows:
          state.rows?.map((n) =>
            n.read_at ? n : { ...n, read_at: action.at }
          ) ?? null,
        outsideUnread: 0,
      };
  }
}
