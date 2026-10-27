import { describe, expect, it } from 'vitest';

import {
  applyGroupFilter,
  avatarToneIndex,
  groupNumbers,
  type GroupListItem,
} from './ui';

const g = (over: Partial<GroupListItem>): GroupListItem => ({
  id: 'g',
  name: 'Group',
  description: null,
  icon_url: null,
  participants_count: 3,
  our_role: 'member',
  channel_id: 'c1',
  channel: { id: 'c1', name: 'Sales', phone: '971500000001' },
  last_message_at: null,
  created_by: null,
  can_manage: false,
  ...over,
});

const support = { id: 'c2', name: 'Support', phone: '971500000002' };
const list = [
  g({ id: 'a', our_role: 'admin' }),
  g({ id: 'b' }),
  g({ id: 'c', our_role: 'left', channel_id: 'c2', channel: support }),
  g({ id: 'd', our_role: 'admin', channel_id: 'c2', channel: support }),
];
const ids = (xs: GroupListItem[]) => xs.map((x) => x.id);

describe('applyGroupFilter', () => {
  it('keeps everything on All with every number', () => {
    expect(
      ids(applyGroupFilter(list, { chip: 'all', channelId: null }))
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('narrows to groups where we are admin, or that we left', () => {
    expect(
      ids(applyGroupFilter(list, { chip: 'admin', channelId: null }))
    ).toEqual(['a', 'd']);
    expect(
      ids(applyGroupFilter(list, { chip: 'left', channelId: null }))
    ).toEqual(['c']);
  });

  it('narrows to one number, combined with a chip', () => {
    expect(
      ids(applyGroupFilter(list, { chip: 'all', channelId: 'c2' }))
    ).toEqual(['c', 'd']);
    expect(
      ids(applyGroupFilter(list, { chip: 'admin', channelId: 'c2' }))
    ).toEqual(['d']);
  });
});

describe('groupNumbers', () => {
  it('lists each number once, by label, skipping removed numbers', () => {
    expect(
      groupNumbers([
        ...list,
        g({ id: 'e', channel_id: null, channel: null }),
        g({
          id: 'f',
          channel_id: 'c3',
          channel: { id: 'c3', name: null, phone: '971500000003' },
        }),
      ])
    ).toEqual([
      { id: 'c3', label: '971500000003' },
      { id: 'c1', label: 'Sales' },
      { id: 'c2', label: 'Support' },
    ]);
  });
});

describe('avatarToneIndex', () => {
  it('is stable for one id and stays within the slots', () => {
    const seeds = ['a', 'b', 'group-1', '7f9c2b1e-0000-4000-8000-000000000001'];
    for (const s of seeds) {
      const i = avatarToneIndex(s, 6);
      expect(i).toBe(avatarToneIndex(s, 6));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(6);
    }
  });

  it('spreads different ids over more than one colour', () => {
    const seen = new Set(
      Array.from({ length: 24 }, (_, n) => avatarToneIndex(`group-${n}`, 6))
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('answers 0 when there are no slots', () => {
    expect(avatarToneIndex('x', 0)).toBe(0);
  });
});
