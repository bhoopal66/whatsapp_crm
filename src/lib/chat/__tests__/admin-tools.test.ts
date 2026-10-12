import { describe, expect, it } from 'vitest';

import {
  adminChannelList,
  chatFilesOfAccount,
  chunked,
  confirmationMatches,
  privateChannelsNotIn,
  reasonOk,
} from '../admin-tools';

describe('reasonOk', () => {
  it('needs 5 characters after trimming', () => {
    expect(reasonOk('  abcd ')).toBe(false);
    expect(reasonOk('abcde')).toBe(true);
    expect(reasonOk('تحقيق')).toBe(true);
  });
});

describe('confirmationMatches', () => {
  it('ignores case and outer spaces, never matches an empty word', () => {
    expect(confirmationMatches(' erase ', 'ERASE')).toBe(true);
    expect(confirmationMatches('eras', 'ERASE')).toBe(false);
    expect(confirmationMatches('', '')).toBe(false);
  });
});

describe('privateChannelsNotIn', () => {
  const rows = [
    { id: 'p2', kind: 'private', name: 'zeta', members: [{ user_id: 'U1' }] },
    { id: 'p1', kind: 'private', name: 'alpha', members: [], archived_at: 'x' },
    { id: 'pm', kind: 'private', name: 'mine', members: [{ user_id: 'me' }] },
    {
      id: 'd1',
      kind: 'dm',
      name: null,
      members: [{ user_id: 'u1' }, { user_id: 'u2' }],
    },
    { id: 'r1', kind: 'deal_room', name: 'deal', members: null },
    { id: 't1', kind: 'team', name: 'general', members: [] },
  ];

  it('keeps private kinds the viewer is not in, by kind then name', () => {
    expect(
      privateChannelsNotIn(rows, 'ME').map((c) => [
        c.id,
        c.archived,
        c.memberIds,
      ])
    ).toEqual([
      ['p1', true, []],
      ['p2', false, ['U1']],
      ['r1', false, []],
      ['d1', false, ['u1', 'u2']],
    ]);
  });
});

describe('chunked', () => {
  it('slices a list', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 2)).toEqual([]);
  });
});

describe('adminChannelList', () => {
  const people = [
    { user_id: 'U1', full_name: 'Zara' },
    { user_id: 'u2', full_name: 'Adam' },
    { user_id: 'u3', full_name: null },
    { user_id: 'me', full_name: 'Me' },
  ];
  const rows = [
    {
      id: 'd1',
      kind: 'dm',
      name: null,
      created_at: '2026-01-01T00:00:00Z',
      members: [{ user_id: 'u1' }, { user_id: 'u3' }],
      internal_messages: [{ created_at: '2026-02-01T00:00:00Z' }],
    },
    {
      id: 'd2',
      kind: 'dm',
      name: null,
      created_at: '2026-01-02T00:00:00Z',
      members: [{ user_id: 'u2' }, { user_id: 'gone' }],
      internal_messages: [],
    },
    {
      id: 'mine',
      kind: 'dm',
      name: null,
      members: [{ user_id: 'u2' }, { user_id: 'ME' }],
    },
    {
      id: 'p1',
      kind: 'private',
      name: 'Ops',
      created_at: '2026-01-03T00:00:00Z',
      archived_at: '2026-03-01T00:00:00Z',
      members: [{ user_id: 'u1' }, { user_id: 'u2' }],
    },
    { id: 't1', kind: 'team', name: 'general', members: [] },
  ];

  it('labels, counts and dates the channels the viewer is not in', () => {
    expect(adminChannelList(rows, 'me', people)).toEqual([
      {
        id: 'p1',
        kind: 'private',
        name: 'Ops',
        memberNames: ['Adam', 'Zara'],
        memberCount: 2,
        lastActivityAt: '2026-01-03T00:00:00Z',
        archived: true,
      },
      {
        id: 'd2',
        kind: 'dm',
        name: null,
        memberNames: ['Adam'],
        memberCount: 2,
        lastActivityAt: '2026-01-02T00:00:00Z',
        archived: false,
      },
      {
        id: 'd1',
        kind: 'dm',
        name: null,
        memberNames: ['Zara'],
        memberCount: 2,
        lastActivityAt: '2026-02-01T00:00:00Z',
        archived: false,
      },
    ]);
  });

  it('answers null when neither a message nor a creation time is known', () => {
    expect(
      adminChannelList(
        [{ id: 'x', kind: 'private', name: 'x', members: [] }],
        'me',
        []
      )[0].lastActivityAt
    ).toBeNull();
  });
});

describe('chatFilesOfAccount', () => {
  const ws = 'AAAAAAAA-0000-4000-8000-000000000001';
  const mine = `account-${ws.toLowerCase()}/channel-c/f-a.png`;

  it('keeps only paths under the workspace prefix', () => {
    expect(
      chatFilesOfAccount(
        [
          mine,
          'account-bbbbbbbb-0000-4000-8000-000000000002/channel-c/f-b.png',
          `x/account-${ws.toLowerCase()}/f.png`,
          `account-${ws.toLowerCase()}/../account-other/f.png`,
          `account-${ws.toLowerCase()}//f.png`,
        ],
        ws
      )
    ).toEqual([mine]);
  });
});
