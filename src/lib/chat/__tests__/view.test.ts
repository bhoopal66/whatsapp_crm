import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ChatError, toChatError, type ChatErrorKey } from '../errors';
import type { ChannelWithMembership, ChatPerson } from '../types';
import {
  AVATAR_TINTS,
  avatarTint,
  boldSegments,
  canManageChannel,
  channelAdminErrorKey,
  channelDisplayName,
  channelEditInput,
  channelSettingsActions,
  chatErrorKey,
  combinedPresence,
  dmDisplayName,
  formatBytes,
  formatClock,
  inboxRows,
  initialOf,
  isChatPath,
  presenceDot,
  muteAction,
  roleLabelKey,
  sidebarRowEmphasis,
  sidebarSections,
  totalUnread,
  UI_ERROR_KEYS,
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
        ch('a2', 'private', 'Closed', { archivedAt: '2026-10-02T00:00:00Z' }),
        ch('a3', 'private', 'hidden', {
          archivedAt: '2026-10-02T00:00:00Z',
          membership: null,
        }),
        ch('a4', 'team', 'unjoined', {
          archivedAt: '2026-10-02T00:00:00Z',
          membership: null,
        }),
        ch('a5', 'dm', null, {
          dmMemberIds: [ME, ANA],
          archivedAt: '2026-10-02T00:00:00Z',
        }),
        ch('d1', 'deal_room', 'Deal B'),
        ch('m1', 'dm', null, { dmMemberIds: [ME, BO] }),
        ch('m2', 'dm', null, { dmMemberIds: [ANA, ME] }),
      ],
      [{ channelId: 'p1', unread: 3, mentions: 1, muted: false }],
      ME,
      people,
      '?'
    );
    expect(s.team.map((r) => r.name)).toEqual(['Alpha', 'beta', 'zeta']);
    expect(s.team[1]).toMatchObject({ unread: 3, mentions: 1 });
    expect(s.dealRooms.map((r) => r.channel.id)).toEqual(['d1']);
    expect(s.dms.map((r) => r.name)).toEqual(['Ana', 'Bo']);
    // Archived team/private channels, under the same listing rule.
    expect(s.archived.map((r) => r.channel.id)).toEqual(['a2', 'a1', 'a4']);
  });
  it('totalUnread sums', () => {
    expect(
      totalUnread([
        { channelId: 'a', unread: 2, mentions: 0, muted: false },
        { channelId: 'b', unread: 5, mentions: 1, muted: false },
      ])
    ).toBe(7);
  });
  it('marks a row muted from the membership, else from the counts', () => {
    const muted = (id: string) => ({
      membership: { ...ch(id, 'team', id).membership!, muted: true },
    });
    const s = sidebarSections(
      [
        ch('t1', 'team', 'a', muted('t1')),
        // A stale count must not override the reloaded membership row.
        ch('t2', 'team', 'b'),
        ch('t3', 'team', 'c', { membership: null }),
        ch('m1', 'dm', null, { dmMemberIds: [ME, BO], ...muted('m1') }),
      ],
      [
        { channelId: 't2', unread: 1, mentions: 0, muted: true },
        { channelId: 't3', unread: 0, mentions: 0, muted: true },
      ],
      ME,
      people,
      '?'
    );
    expect(s.team.map((r) => [r.channel.id, r.muted])).toEqual([
      ['t1', true],
      ['t2', false],
      ['t3', true],
    ]);
    expect(s.dms[0].muted).toBe(true);
  });
  it('sidebarRowEmphasis: a muted row is dimmed, never bold, and keeps its mentions pill', () => {
    const row = (unread: number, mentions: number, muted: boolean) => ({
      unread,
      mentions,
      muted,
    });
    expect(sidebarRowEmphasis(row(4, 0, false), false)).toEqual({
      bold: true,
      dimmed: false,
      badge: { kind: 'unread', count: 4 },
    });
    expect(sidebarRowEmphasis(row(4, 2, false), false)).toEqual({
      bold: true,
      dimmed: false,
      badge: { kind: 'mentions', count: 2 },
    });
    expect(sidebarRowEmphasis(row(4, 0, true), false)).toEqual({
      bold: false,
      dimmed: true,
      badge: { kind: 'unread', count: 4 },
    });
    expect(sidebarRowEmphasis(row(0, 0, true), false)).toEqual({
      bold: false,
      dimmed: true,
      badge: null,
    });
    expect(sidebarRowEmphasis(row(4, 1, true), false)).toEqual({
      bold: false,
      dimmed: true,
      badge: { kind: 'mentions', count: 1 },
    });
    // The open channel shows no count, muted or not.
    for (const muted of [false, true])
      expect(sidebarRowEmphasis(row(4, 1, muted), true)).toEqual({
        bold: false,
        dimmed: false,
        badge: null,
      });
  });
  it('muteAction: a member mutes or unmutes; a non-member gets nothing', () => {
    expect(muteAction({ muted: false })).toBe('mute');
    expect(muteAction({ muted: true })).toBe('unmute');
    expect(muteAction(null)).toBeNull();
    expect(muteAction(undefined)).toBeNull();
  });
  it('totalUnread counts a muted channel by its mentions only, as the rail does', () => {
    expect(
      totalUnread([
        { channelId: 'a', unread: 2, mentions: 0, muted: false },
        { channelId: 'b', unread: 5, mentions: 1, muted: true },
        { channelId: 'c', unread: 9, mentions: 0, muted: true },
      ])
    ).toBe(3);
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
      'dmSize'
    );
    expect(
      chatErrorKey(new ChatError('NOT_FOUND', 'later' as ChatErrorKey, 'x'))
    ).toBe('notFound');
    expect(chatErrorKey(new Error('boom'))).toBe('unknown');
  });
  it('every error key has wording in en.json', () => {
    const en = JSON.parse(
      readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
    ) as { Chat: { errors: Record<string, string> } };
    const missing = UI_ERROR_KEYS.filter((k) => !en.Chat.errors[k]);
    expect(missing).toEqual([]);
    expect(UI_ERROR_KEYS).toContain('duplicateName');
  });
});

describe('channel settings (091)', () => {
  const m = (
    o: Partial<Parameters<typeof channelSettingsActions>[0]> = {}
  ): Parameters<typeof channelSettingsActions>[0] => ({
    kind: 'team',
    archived: false,
    myRole: 'member',
    accountRole: 'agent',
    ...o,
  });

  it('mirrors chat_assert_can_manage_channel', () => {
    // Team: a channel admin, or a workspace owner/admin member or not.
    expect(canManageChannel(m({ myRole: 'admin' }))).toBe(true);
    expect(canManageChannel(m())).toBe(false);
    expect(canManageChannel(m({ myRole: null }))).toBe(false);
    expect(canManageChannel(m({ myRole: null, accountRole: 'admin' }))).toBe(
      true
    );
    expect(canManageChannel(m({ myRole: null, accountRole: 'owner' }))).toBe(
      true
    );
    expect(canManageChannel(m({ accountRole: 'team_leader' }))).toBe(false);
    // Private: the same, but only from inside it (D-B1).
    const p = (o: Parameters<typeof m>[0]) => m({ kind: 'private', ...o });
    expect(canManageChannel(p({ myRole: 'admin' }))).toBe(true);
    expect(canManageChannel(p({ accountRole: 'admin' }))).toBe(true);
    expect(canManageChannel(p({ myRole: null, accountRole: 'owner' }))).toBe(
      false
    );
    expect(canManageChannel(p({}))).toBe(false);
    // Never a DM or deal room; never a bank guest, whatever the row says.
    for (const kind of ['dm', 'deal_room'] as const)
      expect(
        canManageChannel(m({ kind, myRole: 'admin', accountRole: 'owner' }))
      ).toBe(false);
    expect(
      canManageChannel(p({ myRole: 'admin', accountRole: 'bank_guest' }))
    ).toBe(false);
    expect(canManageChannel(m({ myRole: 'admin', accountRole: null }))).toBe(
      false
    );
    expect(canManageChannel(m({ myRole: 'admin', accountRole: 'boss' }))).toBe(
      false
    );
  });

  it('offers edit and archive on a live channel, only unarchive on an archived one', () => {
    expect(channelSettingsActions(m({ myRole: 'admin' }))).toEqual({
      edit: true,
      archive: true,
      unarchive: false,
    });
    expect(
      channelSettingsActions(m({ myRole: 'admin', archived: true }))
    ).toEqual({ edit: false, archive: false, unarchive: true });
    expect(channelSettingsActions(m({ archived: true }))).toEqual({
      edit: false,
      archive: false,
      unarchive: false,
    });
  });

  const sales = { id: 'c1', name: 'Sales Team', topic: 'Q3 ' };
  const others = [
    { id: 'c1', kind: 'team' as const, name: 'Sales Team', archivedAt: null },
    { id: 'c2', kind: 'private' as const, name: 'ops', archivedAt: null },
    {
      id: 'c3',
      kind: 'team' as const,
      name: 'old',
      archivedAt: '2026-10-02T00:00:00Z',
    },
  ];

  it('builds the updateChannel input: null keeps, blank topic clears', () => {
    const edit = (name: string, topic: string) =>
      channelEditInput({ name, topic }, sales, others);
    expect(edit('Sales Team', 'Q3')).toBe('unchanged');
    expect(edit(' Sales Team ', ' Q3 ')).toBe('unchanged');
    expect(edit('Sales Team', '')).toEqual({ name: null, topic: '' });
    expect(edit('Sales Team', ' Q4 ')).toEqual({ name: null, topic: 'Q4' });
    expect(edit('  Big Deals ', 'Q3')).toEqual({
      name: 'big-deals',
      topic: null,
    });
    // The channel's own name is not "taken"; an archived one's is free.
    expect(edit('sales team', 'Q3')).toEqual({
      name: 'sales-team',
      topic: null,
    });
    expect(edit('old', 'Q3')).toEqual({ name: 'old', topic: null });
    expect(edit('OPS', 'Q3')).toBe('taken');
    expect(edit('  ', 'Q3')).toBe('empty');
    expect(
      channelEditInput({ name: 'x', topic: 'y'.repeat(300) }, sales, [])
    ).toEqual({ name: 'x', topic: 'y'.repeat(250) });
  });

  it('words a refused channel-admin write for what was tried', () => {
    const e = (code: string, message: string) => toChatError({ code, message });
    const admin = e(
      '42501',
      'chat_update_channel: only channel admins or workspace owner/admin can manage a channel'
    );
    expect(channelAdminErrorKey('edit', admin)).toBe(
      'settings.errors.adminRequired'
    );
    expect(
      channelAdminErrorKey(
        'remove',
        e(
          '42501',
          'chat_remove_member: not a member of this channel (owner/admin: use chat_admin_read_private to read a private channel)'
        )
      )
    ).toBe('settings.errors.notChannelMember');
    expect(
      channelAdminErrorKey(
        'edit',
        e('42501', 'chat_update_channel: channel is archived')
      )
    ).toBe('settings.errors.archived');
    const dup = e(
      '23505',
      'duplicate key value violates unique constraint "chat_channels_name_uq"'
    );
    expect(channelAdminErrorKey('unarchive', dup)).toBe(
      'settings.errors.unarchiveNameTaken'
    );
    expect(channelAdminErrorKey('edit', dup)).toBe('errors.duplicateName');
    expect(
      channelAdminErrorKey(
        'remove',
        e(
          '22023',
          'chat_remove_member: the last admin of a channel cannot be removed'
        )
      )
    ).toBe('errors.lastAdmin');
    expect(channelAdminErrorKey('archive', new Error('offline'))).toBe(
      'errors.unknown'
    );
    // Every key it can return has English wording.
    const en = JSON.parse(
      readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
    ).Chat;
    for (const k of [
      'adminRequired',
      'notChannelMember',
      'archived',
      'unarchiveNameTaken',
    ])
      expect(en.settings.errors[k]).toBeTruthy();
  });
});
