import { describe, expect, it } from 'vitest';

import type { Notification } from '@/types';

import {
  INITIAL_NOTIFICATIONS_STATE,
  notificationsReducer as reduce,
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
    unreadTotal: 5,
  });
}

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
    const state = reduce(loaded(), { type: 'markAllRead', at: AT });
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
      unreadTotal: 1,
    });
    expect(state.outsideUnread).toBe(0);
    expect(unreadCount(state)).toBe(2);
  });
});
