import { describe, expect, it } from 'vitest';

import type { Notification } from '@/types';

import {
  INITIAL_NOTIFICATIONS_STATE,
  MAX_RELOAD,
  NOTIFICATIONS_PAGE,
  changeFromPayload,
  compareTimes,
  loadDepth,
  markAllBound,
  notificationsReducer as reduce,
  olderCursor,
  olderThan,
  pageOf,
  unreadCount,
  type NotificationsState,
} from './store';

const row = (id: string, read = false): Notification => ({
  id,
  account_id: 'a',
  user_id: 'u',
  type: 'conversation_assigned',
  title: id,
  created_at: '2026-10-27T10:00:00Z',
  ...(read ? { read_at: '2026-10-27T10:05:00Z' } : {}),
});

const AT = '2026-10-27T11:00:00Z';

/** Two unread and one read row loaded, with 3 more unread older ones. */
function loaded(): NotificationsState {
  return reduce(INITIAL_NOTIFICATIONS_STATE, {
    type: 'loaded',
    rows: [row('a'), row('b'), row('c', true)],
    hasOlder: true,
    unreadTotal: 5,
    olderPages: 0,
  });
}

const ids = (state: NotificationsState) => state.rows?.map((n) => n.id);

describe('before the list is loaded', () => {
  const counted = reduce(INITIAL_NOTIFICATIONS_STATE, {
    type: 'count',
    unread: 4,
  });

  it('shows the head count', () => {
    expect(unreadCount(counted)).toBe(4);
    expect(counted.rows).toBeNull();
  });

  it('counts a realtime insert, and only an unread one', () => {
    expect(
      unreadCount(reduce(counted, { type: 'insert', row: row('n') }))
    ).toBe(5);
    expect(
      unreadCount(reduce(counted, { type: 'insert', row: row('n', true) }))
    ).toBe(4);
  });

  it('counts a read elsewhere down, never below zero', () => {
    const once = reduce(counted, { type: 'update', row: row('x', true) });
    expect(unreadCount(once)).toBe(3);
    const zero = reduce(INITIAL_NOTIFICATIONS_STATE, {
      type: 'update',
      row: row('x', true),
    });
    expect(unreadCount(zero)).toBe(0);
  });
});

describe('once the list is loaded', () => {
  it('counts the window plus the unread rows outside it', () => {
    const state = loaded();
    expect(state.outsideUnread).toBe(3);
    expect(unreadCount(state)).toBe(5);
  });

  it('ignores a late head count', () => {
    expect(unreadCount(reduce(loaded(), { type: 'count', unread: 0 }))).toBe(5);
  });

  it('adds an insert to the top once', () => {
    const once = reduce(loaded(), { type: 'insert', row: row('n') });
    expect(once.rows?.map((n) => n.id)).toEqual(['n', 'a', 'b', 'c']);
    expect(unreadCount(once)).toBe(6);
    expect(reduce(once, { type: 'insert', row: row('n') })).toBe(once);
  });

  it('moves the count by one when a row is read, echo included', () => {
    const read = reduce(loaded(), { type: 'markRead', id: 'a', at: AT });
    expect(unreadCount(read)).toBe(4);
    // The realtime echo of the same write must not count it twice.
    const echoed = reduce(read, {
      type: 'update',
      row: { ...row('a'), read_at: AT },
    });
    expect(unreadCount(echoed)).toBe(4);
    // Reading a row already read changes nothing.
    expect(
      unreadCount(reduce(echoed, { type: 'markRead', id: 'a', at: AT }))
    ).toBe(4);
  });

  it('counts a read of an older row outside the window', () => {
    const state = reduce(loaded(), { type: 'update', row: row('old', true) });
    expect(unreadCount(state)).toBe(4);
  });

  it('marks every row read, the ones outside the window too', () => {
    const state = reduce(loaded(), {
      type: 'markAllRead',
      at: AT,
      upTo: markAllBound(loaded())!,
    });
    expect(unreadCount(state)).toBe(0);
    expect(state.rows?.every((n) => n.read_at)).toBe(true);
    // The echoes of that write leave it at zero.
    expect(
      unreadCount(reduce(state, { type: 'update', row: row('old', true) }))
    ).toBe(0);
  });

  it('drops a deleted row', () => {
    const state = reduce(loaded(), { type: 'delete', row: { id: 'a' } });
    expect(state.rows?.map((n) => n.id)).toEqual(['b', 'c']);
    expect(unreadCount(state)).toBe(4);
  });

  it('never goes negative when the two counts disagree', () => {
    const state = reduce(INITIAL_NOTIFICATIONS_STATE, {
      type: 'loaded',
      rows: [row('a'), row('b')],
      hasOlder: false,
      unreadTotal: 1,
      olderPages: 0,
    });
    expect(state.outsideUnread).toBe(0);
    expect(unreadCount(state)).toBe(2);
  });
});

describe('older pages', () => {
  const older = (state: NotificationsState, after = 'c') =>
    reduce(state, {
      type: 'olderLoaded',
      after,
      rows: [row('d'), row('e'), row('f', true)],
      hasOlder: true,
    });
  const reload = (asked: NotificationsState, rows: Notification[]) =>
    ({
      type: 'loaded',
      rows,
      hasOlder: true,
      unreadTotal: 5,
      olderPages: asked.olderPages,
    }) as const;

  it('go under the list, and leave the total as it was', () => {
    const state = older(loaded());
    expect(ids(state)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // Two of the three unread rows outside are in the list now.
    expect(state.outsideUnread).toBe(1);
    expect(unreadCount(state)).toBe(5);
  });

  it('bring a row already listed only once', () => {
    // An event's row is at the front whatever its time.
    const state = older(reduce(loaded(), { type: 'insert', row: row('d') }));
    expect(ids(state)).toEqual(['d', 'a', 'b', 'c', 'e', 'f']);
    expect(state.outsideUnread).toBe(2);
  });

  it('are dropped when the list no longer ends where they begin', () => {
    const gone = reduce(loaded(), { type: 'delete', row: { id: 'c' } });
    expect(older(gone)).toBe(gone);
    expect(older(INITIAL_NOTIFICATIONS_STATE)).toBe(
      INITIAL_NOTIFICATIONS_STATE
    );
    // Asked for twice: the second answer is the same page.
    const once = older(loaded());
    expect(older(once)).toBe(once);
  });

  it('say whether more follow', () => {
    expect(olderCursor(loaded())?.id).toBe('c');
    const end = reduce(loaded(), {
      type: 'olderLoaded',
      after: 'c',
      rows: [],
      hasOlder: false,
    });
    expect(olderCursor(end)).toBeNull();
    expect(olderCursor(INITIAL_NOTIFICATIONS_STATE)).toBeNull();
  });

  it('continue from the last row, whatever was put at the front', () => {
    const state = reduce(loaded(), {
      type: 'insert',
      row: { ...row('late'), created_at: '2020-01-01T00:00:00Z' },
    });
    expect(olderCursor(state)?.id).toBe('c');
  });

  it('stay when a reload that was asked for before them lands', () => {
    const asked = loaded();
    const state = reduce(
      older(asked),
      reload(asked, [row('n'), row('a'), row('b')])
    );
    expect(ids(state)).toEqual(['n', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(unreadCount(state)).toBe(5);
  });

  it('keep the end they reached when that reload lands', () => {
    const asked = loaded();
    const end = reduce(asked, {
      type: 'olderLoaded',
      after: 'c',
      rows: [row('d')],
      hasOlder: false,
    });
    expect(
      reduce(end, reload(asked, [row('a'), row('b'), row('c')])).hasOlder
    ).toBe(false);
  });

  it('go when a reload no longer reaches them: the list has no hole', () => {
    const asked = loaded();
    const state = reduce(older(asked), reload(asked, [row('y'), row('z')]));
    expect(ids(state)).toEqual(['y', 'z']);
    expect(state.hasOlder).toBe(true);
  });

  it('are the reload’s own when it was asked for after them', () => {
    // A row deleted meanwhile must not come back, nor a stale unread one.
    const asked = older(loaded());
    const state = reduce(asked, reload(asked, [row('a'), row('d', true)]));
    expect(ids(state)).toEqual(['a', 'd']);
    expect(state.olderPages).toBe(1);
  });
});

describe('how deep a reload goes', () => {
  const deep = (n: number, olderPages: number): NotificationsState => ({
    rows: Array.from({ length: n }, (_, i) => row(String(i))),
    outsideUnread: 0,
    hasOlder: true,
    olderPages,
  });

  it('is one page until an older one was asked for', () => {
    expect(loadDepth(INITIAL_NOTIFICATIONS_STATE)).toBe(NOTIFICATIONS_PAGE);
    expect(loadDepth(deep(130, 0))).toBe(NOTIFICATIONS_PAGE);
  });

  it('is the whole list after that, within what PostgREST answers', () => {
    expect(loadDepth(deep(230, 2))).toBe(230);
    expect(loadDepth(deep(3, 1))).toBe(NOTIFICATIONS_PAGE);
    expect(loadDepth(deep(1200, 11))).toBe(MAX_RELOAD);
  });

  it('reads one row more to know whether older ones follow', () => {
    const read = [row('a'), row('b'), row('c')];
    expect(pageOf(read, 2)).toEqual({ rows: read.slice(0, 2), hasOlder: true });
    expect(pageOf(read, 3)).toEqual({ rows: read, hasOlder: false });
  });
});

describe('the older filter', () => {
  it("is the row's own time string, with the id deciding a tie", () => {
    expect(
      olderThan({ id: 'x', created_at: '2026-10-27T10:00:00.123456+00:00' })
    ).toBe(
      'created_at.lt."2026-10-27T10:00:00.123456+00:00",and(created_at.eq."2026-10-27T10:00:00.123456+00:00",id.lt.x)'
    );
  });
});

describe('compareTimes', () => {
  it.each([
    ['2026-10-27T10:00:00.123456+00:00', '2026-10-27T10:00:00.123457+00:00'],
    ['2026-10-27T10:00:00+00:00', '2026-10-27T10:00:00.000001+00:00'],
    ['2026-10-27T10:00:00.12+00:00', '2026-10-27T10:00:00.1203+00:00'],
    ['2026-10-27T10:00:00Z', '2026-10-27T10:00:00.5Z'],
    ['2026-10-27T13:00:00.9+04:00', '2026-10-27T10:00:00+00:00'],
  ])('%s is before %s', (a, b) => {
    expect(compareTimes(a, b)).toBeLessThan(0);
    expect(compareTimes(b, a)).toBeGreaterThan(0);
    expect(compareTimes(a, a)).toBe(0);
  });
});

describe('mark all as read', () => {
  const at = (id: string, created_at: string) => ({ ...row(id), created_at });
  const first = '2026-10-27T10:00:00.123456+00:00';
  const next = '2026-10-27T10:00:00.123457+00:00';
  const list = (...rows: Notification[]) =>
    reduce(INITIAL_NOTIFICATIONS_STATE, {
      type: 'loaded',
      rows,
      hasOlder: true,
      unreadTotal: rows.length + 2,
      olderPages: 0,
    });

  it('covers up to the newest row listed, wherever it is', () => {
    expect(markAllBound(list(at('a', first), at('b', next)))).toBe(next);
    expect(markAllBound(list(at('b', next), at('a', first)))).toBe(next);
  });

  it('does nothing before a list is loaded, or with nothing unread', () => {
    const counted = reduce(INITIAL_NOTIFICATIONS_STATE, {
      type: 'count',
      unread: 4,
    });
    expect(markAllBound(counted)).toBeNull();
    const read = reduce(INITIAL_NOTIFICATIONS_STATE, {
      type: 'loaded',
      rows: [row('a', true)],
      hasOlder: false,
      unreadTotal: 0,
      olderPages: 0,
    });
    expect(markAllBound(read)).toBeNull();
    // Unread only in the rows not loaded: still something to mark.
    expect(markAllBound({ ...read, outsideUnread: 1 })).not.toBeNull();
  });

  it('leaves a newer row unread, and reads the older ones not listed', () => {
    const before = list(at('a', first));
    const upTo = markAllBound(before)!;
    const arrived = reduce(before, { type: 'insert', row: at('n', next) });
    const state = reduce(arrived, { type: 'markAllRead', at: AT, upTo });
    expect(state.rows?.map((n) => n.read_at)).toEqual([undefined, AT]);
    expect(state.outsideUnread).toBe(0);
    expect(state.hasOlder).toBe(true);
  });
});

describe('changeFromPayload', () => {
  const row = { id: 'a' };

  it('turns each realtime event into the action that applies it', () => {
    expect(
      changeFromPayload({ eventType: 'INSERT', new: row, old: {} })
    ).toEqual({ type: 'insert', row });
    expect(
      changeFromPayload({ eventType: 'UPDATE', new: row, old: {} })
    ).toEqual({ type: 'update', row });
  });

  it('a DELETE carries the old row, which is only its key', () => {
    expect(
      changeFromPayload({ eventType: 'DELETE', new: {}, old: row })
    ).toEqual({ type: 'delete', row });
  });

  it('ignores anything else', () => {
    expect(
      changeFromPayload({ eventType: 'TRUNCATE', new: {}, old: {} })
    ).toBeNull();
  });
});
