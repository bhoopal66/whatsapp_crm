import { describe, expect, it } from 'vitest';

import type { ChannelMember, ChatMessage } from '../types';
import {
  applyMemberEvent,
  firstUnreadId,
  lastOwnTopLevelId,
  receiptLabel,
  RECEIPTS_MAX_MEMBERS,
  unreadSince,
} from '../receipts';

type Msg = Pick<
  ChatMessage,
  | 'id'
  | 'threadRootId'
  | 'authorKind'
  | 'authorId'
  | 'createdAt'
  | 'deletedAt'
  | 'erasedAt'
>;

const msg = (
  id: string,
  at: string,
  authorId: string | null,
  o: Partial<Msg> = {}
): Msg => ({
  id,
  threadRootId: null,
  authorKind: authorId === null ? 'system' : 'user',
  authorId,
  createdAt: `2026-10-30T${at}:00Z`,
  deletedAt: null,
  erasedAt: null,
  ...o,
});

const since = '2026-10-30T10:00:00Z';

describe('unreadSince', () => {
  it('is the later of the read mark and the join, skipping nulls', () => {
    expect(
      unreadSince({ lastReadAt: '2026-10-30T11:00:00Z', joinedAt: since })
    ).toBe('2026-10-30T11:00:00Z');
    expect(
      unreadSince({ lastReadAt: since, joinedAt: '2026-10-30T12:00:00Z' })
    ).toBe('2026-10-30T12:00:00Z');
    expect(unreadSince({ lastReadAt: null, joinedAt: since })).toBe(since);
    expect(unreadSince(null)).toBeNull();
  });
});

describe('firstUnreadId', () => {
  it('skips own messages, thread replies and deleted or erased ones', () => {
    const messages = [
      msg('old', '09:00', 'a'),
      msg('mine', '10:01', 'ME'),
      msg('reply', '10:02', 'a', { threadRootId: 'old' }),
      msg('deleted', '10:03', 'a', { deletedAt: '2026-10-30T10:05:00Z' }),
      msg('erased', '10:04', 'a', { erasedAt: '2026-10-30T10:05:00Z' }),
      msg('first', '10:05', 'b'),
      msg('later', '10:06', 'a'),
    ];
    expect(firstUnreadId(messages, since, 'me')).toBe('first');
  });

  it('counts a system post, as the unread badge does', () => {
    const messages = [msg('sys', '10:01', null), msg('b', '10:02', 'b')];
    expect(firstUnreadId(messages, since, 'me')).toBe('sys');
  });

  it('is strictly after the mark', () => {
    expect(firstUnreadId([msg('x', '10:00', 'a')], since, 'me')).toBeNull();
  });

  it('has no divider without a mark (null lastReadAt and no join)', () => {
    expect(firstUnreadId([msg('x', '10:01', 'a')], null, 'me')).toBeNull();
    expect(
      firstUnreadId(
        [msg('x', '10:01', 'a')],
        unreadSince({ lastReadAt: null, joinedAt: since }),
        'me'
      )
    ).toBe('x');
  });

  it('ignores messages after `until` (arrived while watching)', () => {
    const messages = [msg('seen', '09:00', 'a'), msg('new', '10:30', 'a')];
    expect(
      firstUnreadId(messages, since, 'me', '2026-10-30T09:00:00Z')
    ).toBeNull();
    expect(firstUnreadId(messages, since, 'me', '2026-10-30T10:30:00Z')).toBe(
      'new'
    );
  });

  it('has none when everything after the mark is the viewer’s', () => {
    expect(firstUnreadId([msg('m', '10:30', 'me')], since, 'me')).toBeNull();
  });
});

describe('lastOwnTopLevelId', () => {
  it('is the newest own top-level message with a body', () => {
    const messages = [
      msg('m1', '09:00', 'me'),
      msg('m2', '09:01', 'ME'),
      msg('other', '09:02', 'a'),
      msg('mine-reply', '09:03', 'me', { threadRootId: 'm1' }),
      msg('mine-deleted', '09:04', 'me', {
        deletedAt: '2026-10-30T09:05:00Z',
      }),
      msg('sys', '09:05', null),
    ];
    expect(lastOwnTopLevelId(messages, 'me')).toBe('m2');
  });

  it('is null with no own message or no viewer', () => {
    expect(lastOwnTopLevelId([msg('a', '09:00', 'a')], 'me')).toBeNull();
    expect(lastOwnTopLevelId([msg('a', '09:00', 'a')], null)).toBeNull();
  });
});

describe('receiptLabel', () => {
  it('says Seen or Sent in a 1:1 dm', () => {
    expect(receiptLabel({ kind: 'dm', memberCount: 2, seenCount: 1 })).toBe(
      'seen'
    );
    expect(receiptLabel({ kind: 'dm', memberCount: 2, seenCount: 0 })).toBe(
      'sent'
    );
  });

  it('counts in a group dm and a small channel', () => {
    expect(receiptLabel({ kind: 'dm', memberCount: 3, seenCount: 2 })).toBe(
      'seenBy'
    );
    expect(receiptLabel({ kind: 'team', memberCount: 20, seenCount: 1 })).toBe(
      'seenBy'
    );
    expect(
      receiptLabel({ kind: 'private', memberCount: 5, seenCount: 0 })
    ).toBe('sent');
  });

  it('shows nothing in a deal room or a channel over the cap', () => {
    expect(
      receiptLabel({ kind: 'deal_room', memberCount: 3, seenCount: 2 })
    ).toBe('none');
    expect(
      receiptLabel({
        kind: 'team',
        memberCount: RECEIPTS_MAX_MEMBERS + 1,
        seenCount: 4,
      })
    ).toBe('none');
  });
});

describe('applyMemberEvent', () => {
  const row = (userId: string, lastReadAt: string | null): ChannelMember => ({
    channelId: 'c',
    userId,
    role: 'member',
    joinedAt: since,
    lastReadAt,
    muted: false,
    postBlockedUntil: null,
  });
  const list = [row('a', null), row('b', since)];

  it('moves a read mark forward on update', () => {
    const next = applyMemberEvent(list, 'c', {
      type: 'update',
      member: row('a', '2026-10-30T11:00:00Z'),
    });
    expect(next.map((m) => m.lastReadAt)).toEqual([
      '2026-10-30T11:00:00Z',
      since,
    ]);
  });

  it('adds a whole row, drops a deleted key, ignores the rest', () => {
    expect(
      applyMemberEvent(list, 'c', { type: 'insert', member: row('d', null) })
    ).toHaveLength(3);
    expect(
      applyMemberEvent(list, 'c', {
        type: 'delete',
        member: { channelId: 'c', userId: 'a' },
      }).map((m) => m.userId)
    ).toEqual(['b']);
    expect(
      applyMemberEvent(list, 'c', {
        type: 'insert',
        member: { channelId: 'c', userId: 'zz' },
      })
    ).toBe(list);
    expect(
      applyMemberEvent(list, 'c', {
        type: 'update',
        member: { ...row('a', since), channelId: 'other' },
      })
    ).toBe(list);
  });
});
