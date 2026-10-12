import { describe, expect, it } from 'vitest';

import { ChatError } from '../errors';
import type { ChannelWithMembership, ChatPerson } from '../types';
import {
  AVATAR_TINTS,
  avatarTint,
  boldSegments,
  channelDisplayName,
  chatErrorKey,
  combinedPresence,
  dmDisplayName,
  formatBytes,
  formatClock,
  inboxRows,
  initialOf,
  isChatPath,
  presenceDot,
  roleLabelKey,
  sidebarSections,
  totalUnread,
} from '../view';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const ANA = 'aaaaaaaa-0000-4000-8000-000000000002';
const BO = 'aaaaaaaa-0000-4000-8000-000000000003';
const people = new Map<string, Pick<ChatPerson, 'fullName'>>([
  [ME, { fullName: 'Me Myself' }],
  [ANA, { fullName: 'Ana' }],
  [BO, { fullName: 'Bo' }],
]);

function ch(
  id: string,
  kind: ChannelWithMembership['kind'],
  name: string | null,
  extra: Partial<ChannelWithMembership> = {}
): ChannelWithMembership {
  return {
    id,
    accountId: 'ws',
    kind,
    name,
    topic: null,
    dmMemberIds: [],
    createdBy: ME,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    membership: {
      channelId: id,
      userId: ME,
      role: 'member',
      joinedAt: '2026-10-01T00:00:00Z',
      lastReadAt: null,
      muted: false,
    },
    ...extra,
  };
}

describe('dmDisplayName', () => {
  it('names a DM by the other people, never the viewer', () => {
    expect(dmDisplayName([ME, ANA], ME, people, '?')).toBe('Ana');
    expect(dmDisplayName([ANA, ME, BO], ME, people, '?')).toBe('Ana, Bo');
    // dm_key ids and chat_people ids may differ in case.
    expect(
      dmDisplayName([ANA.toUpperCase(), ME.toUpperCase()], ME, people, '?')
    ).toBe('Ana');
  });
  it('falls back for unknown people and names a self-DM after the viewer', () => {
    expect(dmDisplayName([ME, 'x'], ME, people, 'Someone')).toBe('Someone');
    expect(dmDisplayName([ME], ME, people, '?')).toBe('Me Myself');
  });
  it('channelDisplayName uses the name for other kinds', () => {
    expect(channelDisplayName(ch('1', 'team', 'ops'), ME, people, '?')).toBe(
      'ops'
    );
    expect(
      channelDisplayName(
        ch('2', 'dm', null, { dmMemberIds: [ME, BO] }),
        ME,
        people,
        '?'
      )
    ).toBe('Bo');
  });
});

describe('presenceDot', () => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  const fresh = '2026-10-12T09:59:30Z';
  it('maps fresh statuses and treats stale or missing as offline', () => {
    expect(
      presenceDot({ presenceStatus: 'online', lastSeenAt: fresh }, now)
    ).toBe('available');
    expect(
      presenceDot({ presenceStatus: 'on_call', lastSeenAt: fresh }, now)
    ).toBe('busy');
    expect(
      presenceDot({ presenceStatus: 'away', lastSeenAt: fresh }, now)
    ).toBe('offline');
    expect(
      presenceDot(
        { presenceStatus: 'online', lastSeenAt: '2026-10-12T09:00:00Z' },
        now
      )
    ).toBe('offline');
    expect(presenceDot(undefined, now)).toBe('offline');
  });
  it('combines a group DM to the liveliest member', () => {
    expect(combinedPresence(['offline', 'busy'])).toBe('busy');
    expect(combinedPresence(['busy', 'available'])).toBe('available');
    expect(combinedPresence([])).toBe('offline');
  });
});

describe('avatar', () => {
  it('gives a stable tint from the palette, case-insensitively', () => {
    expect(AVATAR_TINTS).toContain(avatarTint(ANA));
    expect(avatarTint(ANA)).toBe(avatarTint(ANA.toUpperCase()));
    expect(
      new Set([ME, ANA, BO, 'x', 'y', 'z'].map(avatarTint)).size
    ).toBeGreaterThan(1);
  });
  it('initial', () => {
    expect(initialOf(' ana')).toBe('A');
    expect(initialOf(null)).toBe('?');
  });
});

describe('sidebarSections', () => {
  it('groups by kind, sorts by name, applies unread and skips what the caller is not in', () => {
    const s = sidebarSections(
      [
        ch('t2', 'team', 'zeta'),
        ch('t1', 'team', 'Alpha', { membership: null }),
        ch('p1', 'private', 'beta'),
        ch('p2', 'private', 'gone', { membership: null }),
        ch('a1', 'team', 'old', { archivedAt: '2026-10-02T00:00:00Z' }),
        ch('d1', 'deal_room', 'Deal B'),
        ch('m1', 'dm', null, { dmMemberIds: [ME, BO] }),
        ch('m2', 'dm', null, { dmMemberIds: [ANA, ME] }),
      ],
      [{ channelId: 'p1', unread: 3, mentions: 1 }],
      ME,
      people,
      '?'
    );
    expect(s.team.map((r) => r.name)).toEqual(['Alpha', 'beta', 'zeta']);
    expect(s.team[1]).toMatchObject({ unread: 3, mentions: 1 });
    expect(s.dealRooms.map((r) => r.channel.id)).toEqual(['d1']);
    expect(s.dms.map((r) => r.name)).toEqual(['Ana', 'Bo']);
  });
  it('totalUnread sums', () => {
    expect(
      totalUnread([
        { channelId: 'a', unread: 2, mentions: 0 },
        { channelId: 'b', unread: 5, mentions: 1 },
      ])
    ).toBe(7);
  });
});

describe('inboxRows', () => {
  const tags = [
    { id: 't1', name: 'Waiting on bank', count: 3 },
    { id: 't2', name: 'Empty', count: 0 },
  ];
  it('admin: unassigned, mine, tags with chats, on /inbox', () => {
    expect(inboxRows({ role: 'admin', unassigned: 4, mine: 12, tags })).toEqual(
      [
        {
          id: 'unassigned',
          kind: 'unassigned',
          label: null,
          count: 4,
          href: '/inbox?assignee=unassigned',
        },
        {
          id: 'mine',
          kind: 'mine',
          label: null,
          count: 12,
          href: '/inbox?assignee=me',
        },
        {
          id: 'tag:t1',
          kind: 'tag',
          label: 'Waiting on bank',
          count: 3,
          href: '/inbox?tag=t1',
        },
      ]
    );
  });
  it('team leader goes to the team inbox; an agent gets no Unassigned row', () => {
    expect(
      inboxRows({ role: 'team_leader', unassigned: 1, mine: 1, tags: [] })[0]
        .href
    ).toBe('/team-inbox?assignee=unassigned');
    expect(
      inboxRows({ role: 'agent', unassigned: 1, mine: 2, tags: [] })
    ).toEqual([
      { id: 'mine', kind: 'mine', label: null, count: 2, href: '/inbox' },
    ]);
  });
});

describe('formatting', () => {
  it('bold markers', () => {
    expect(boldSegments('Deal **ACME** moved to **Won**')).toEqual([
      { text: 'Deal ', bold: false },
      { text: 'ACME', bold: true },
      { text: ' moved to ', bold: false },
      { text: 'Won', bold: true },
    ]);
    expect(boldSegments('a **b')).toEqual([{ text: 'a **b', bold: false }]);
  });
  it('bytes and clock', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatClock('2026-10-12T09:05:00Z', 'Asia/Dubai')).toBe('13:05');
    expect(formatClock('nope')).toBe('');
  });
  it('role labels and chat paths', () => {
    expect(roleLabelKey('team_leader')).toBe('roleTeamLeader');
    expect(roleLabelKey('x')).toBeNull();
    expect(isChatPath('/chat')).toBe(true);
    expect(isChatPath('/chat/abc')).toBe(true);
    expect(isChatPath('/chatter')).toBe(false);
  });
  it('error keys fall back to a coarse or unknown key', () => {
    expect(chatErrorKey(new ChatError('FORBIDDEN', 'archived', 'x'))).toBe(
      'archived'
    );
    expect(chatErrorKey(new ChatError('INVALID', 'dmSize', 'x'))).toBe(
      'invalid'
    );
    expect(
      chatErrorKey(new ChatError('NOT_FOUND', 'attachmentMissing', 'x'))
    ).toBe('notFound');
    expect(chatErrorKey(new Error('boom'))).toBe('unknown');
  });
});
