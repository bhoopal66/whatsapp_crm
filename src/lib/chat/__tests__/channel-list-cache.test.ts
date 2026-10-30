import { describe, expect, it } from 'vitest';

import { isOwnMemberEvent, patchOwnReadMark } from '../channel-list-cache';
import type { MemberEvent } from '../receipts';
import type { ChannelMember, ChannelWithMembership } from '../types';

const me: ChannelMember = {
  channelId: 'c1',
  userId: 'u1',
  role: 'member',
  joinedAt: '2026-10-01T00:00:00Z',
  lastReadAt: '2026-10-30T08:00:00Z',
  muted: false,
};

function channel(
  id: string,
  membership: ChannelMember | null
): ChannelWithMembership {
  return {
    id,
    membership,
  } as unknown as ChannelWithMembership;
}

const list = () => [channel('c1', me), channel('c2', null)];

const update = (member: Partial<ChannelMember>): MemberEvent => ({
  type: 'update',
  member: { ...me, ...member },
});

describe('patchOwnReadMark', () => {
  it('patches the viewer’s own read mark in place', () => {
    const before = list();
    const after = patchOwnReadMark(
      before,
      update({ lastReadAt: '2026-10-30T09:00:00Z' }),
      'u1'
    );
    expect(after).not.toBeNull();
    expect(after![0].membership?.lastReadAt).toBe('2026-10-30T09:00:00Z');
    expect(after![1]).toBe(before[1]);
    // The cached list is not mutated.
    expect(before[0].membership?.lastReadAt).toBe('2026-10-30T08:00:00Z');
  });

  it('matches the user id case-insensitively', () => {
    expect(
      patchOwnReadMark(
        list(),
        update({ userId: 'U1', lastReadAt: '2026-10-30T09:00:00Z' }),
        'u1'
      )
    ).not.toBeNull();
  });

  it('returns the same list when the echo changes nothing', () => {
    const before = list();
    expect(patchOwnReadMark(before, update({}), 'u1')).toBe(before);
  });

  it('reloads for another person’s row', () => {
    expect(
      patchOwnReadMark(
        list(),
        update({ userId: 'u2', lastReadAt: '2026-10-30T09:00:00Z' }),
        'u1'
      )
    ).toBeNull();
  });

  it('reloads when anything but the read mark moved', () => {
    for (const change of [
      { role: 'admin' as const },
      { muted: true },
      { joinedAt: '2026-10-02T00:00:00Z' },
    ]) {
      expect(
        patchOwnReadMark(
          list(),
          update({ ...change, lastReadAt: '2026-10-30T09:00:00Z' }),
          'u1'
        )
      ).toBeNull();
    }
  });

  it('reloads for inserts, deletes and channels not held as a member', () => {
    const at = { lastReadAt: '2026-10-30T09:00:00Z' };
    expect(
      patchOwnReadMark(list(), { ...update(at), type: 'insert' }, 'u1')
    ).toBeNull();
    expect(
      patchOwnReadMark(
        list(),
        { type: 'delete', member: { channelId: 'c1', userId: 'u1' } },
        'u1'
      )
    ).toBeNull();
    expect(
      patchOwnReadMark(list(), update({ ...at, channelId: 'c2' }), 'u1')
    ).toBeNull();
    expect(
      patchOwnReadMark(list(), update({ ...at, channelId: 'c9' }), 'u1')
    ).toBeNull();
  });

  it('reloads for a partial row without a read mark', () => {
    expect(
      patchOwnReadMark(
        list(),
        {
          type: 'update',
          member: { channelId: 'c1', userId: 'u1', role: 'member' },
        },
        'u1'
      )
    ).toBeNull();
  });
});

describe('isOwnMemberEvent', () => {
  const ev = (userId: string, type: MemberEvent['type'] = 'update') =>
    ({ type, member: { channelId: 'c1', userId } }) as MemberEvent;

  it("is true only for the viewer's own row, whatever the case", () => {
    expect(isOwnMemberEvent(ev('U-1'), 'u-1')).toBe(true);
    expect(isOwnMemberEvent(ev('u-2'), 'u-1')).toBe(false);
  });

  it("ignores another person's join, leave and read mark alike", () => {
    for (const type of ['insert', 'update', 'delete'] as const)
      expect(isOwnMemberEvent(ev('u-2', type), 'u-1')).toBe(false);
  });
});
