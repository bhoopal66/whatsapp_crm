/**
 * The sidebar's live mirror of the unread chats (useUnreadChats): what
 * the last read said, adjusted by every realtime event since. Only rows
 * with something unread are held; a chat not in it counts as 0.
 *
 * A read REPLACES the mirror, so a chat the viewer may no longer see
 * (reassigned: RLS stops its events, so nothing else would say so) drops
 * out, except for the chats an event touched while the read was in
 * flight: the event is newer than the answer.
 */
export interface UnreadMirrorRow {
  id: string;
  unread_count?: number | null;
}

export interface UnreadMirror<R extends UnreadMirrorRow> {
  rows: ReadonlyMap<string, R>;
  /** The newest read in flight and what events changed since it began. */
  read: { seq: number; touched: ReadonlyMap<string, R | null> } | null;
}

export type UnreadMirrorAction<R extends UnreadMirrorRow> =
  /** A newer read takes over from one still in flight. */
  | { type: 'readStarted'; seq: number }
  | { type: 'readLanded'; seq: number; rows: readonly R[] }
  /** A realtime event; `row` is null for a deleted chat. */
  | { type: 'change'; id: string; row: R | null };

export function emptyUnreadMirror<
  R extends UnreadMirrorRow,
>(): UnreadMirror<R> {
  return { rows: new Map(), read: null };
}

function put<R extends UnreadMirrorRow>(
  rows: Map<string, R>,
  id: string,
  row: R | null
) {
  if (row && (row.unread_count ?? 0) > 0) rows.set(id, row);
  else rows.delete(id);
}

export function unreadMirrorReducer<R extends UnreadMirrorRow>(
  state: UnreadMirror<R>,
  action: UnreadMirrorAction<R>
): UnreadMirror<R> {
  switch (action.type) {
    case 'readStarted':
      return { ...state, read: { seq: action.seq, touched: new Map() } };
    case 'readLanded': {
      if (state.read?.seq !== action.seq) return state;
      const rows = new Map<string, R>();
      for (const row of action.rows) put(rows, row.id, row);
      for (const [id, row] of state.read.touched) put(rows, id, row);
      return { rows, read: null };
    }
    case 'change': {
      const { id, row } = action;
      const rows = new Map(state.rows);
      put(rows, id, row);
      return {
        rows,
        read: state.read && {
          ...state.read,
          touched: new Map(state.read.touched).set(id, row),
        },
      };
    }
  }
}

/** Does this event raise the chat's unread count (a new message)? */
export function unreadRose<R extends UnreadMirrorRow>(
  state: UnreadMirror<R>,
  row: R
): boolean {
  return (row.unread_count ?? 0) > (state.rows.get(row.id)?.unread_count ?? 0);
}
