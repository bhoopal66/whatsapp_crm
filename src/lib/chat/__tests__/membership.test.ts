import { describe, expect, it } from 'vitest';

import {
  addCandidates,
  addRules,
  canSetRoles,
  leaveBlock,
  roleChange,
  sortMembers,
  type ChannelCtx,
} from '../membership';
import type { ChannelMember, ChannelRole, ChatPerson } from '../types';

const person = (
  userId: string,
  role: string,
  fullName = userId
): ChatPerson => ({
  userId,
  fullName,
  avatarUrl: null,
  role,
  bankCode: null,
  presenceStatus: null,
  lastSeenAt: null,
});
const member = (userId: string, role: ChannelRole): ChannelMember => ({
  channelId: 'c1',
  userId,
  role,
  joinedAt: '2026-10-01T00:00:00Z',
  lastReadAt: null,
  muted: false,
});

const people = [
  person('me', 'agent', 'Me'),
  person('ann', 'agent', 'Ann'),
  person('bob', 'team_leader', 'Bob'),
  person('gus', 'bank_guest', 'Gus'),
];
const byId = new Map(people.map((p) => [p.userId, p]));
const ctx = (o: Partial<ChannelCtx>): ChannelCtx => ({
  kind: 'private',
  archived: false,
  myRole: 'member',
  accountRole: 'agent',
  ...o,
});
const offered = (
  c: ChannelCtx,
  members: ChannelMember[] = [member('me', c.myRole ?? 'member')]
) => addCandidates(people, members, addRules(c)).map((p) => p.userId);

describe('addRules / addCandidates', () => {
  it('team: any non-guest adds non-guests, never a bank guest', () => {
    expect(offered(ctx({ kind: 'team', myRole: null }))).toEqual([
      'ann',
      'bob',
    ]);
    expect(offered(ctx({ kind: 'team', accountRole: 'owner' }))).not.toContain(
      'gus'
    );
  });

  it('private: a non-admin member who is a plain agent may add nobody', () => {
    const c = ctx({ myRole: 'member', accountRole: 'agent' });
    expect(addRules(c)).toEqual({
      staff: false,
      guests: false,
      block: 'notAdmin',
    });
    expect(offered(c)).toEqual([]);
  });

  it('private: a channel admin adds non-guests; a guest only with a leading workspace role', () => {
    expect(offered(ctx({ myRole: 'admin', accountRole: 'agent' }))).toEqual([
      'ann',
      'bob',
    ]);
    expect(
      offered(ctx({ myRole: 'admin', accountRole: 'team_leader' }))
    ).toEqual(['ann', 'bob', 'gus']);
  });

  it('private: a non-admin member who is workspace admin adds bank guests only', () => {
    expect(offered(ctx({ myRole: 'member', accountRole: 'admin' }))).toEqual([
      'gus',
    ]);
  });

  it('private: a non-member, a DM, a deal room, an archive and a guest add nobody', () => {
    expect(addRules(ctx({ myRole: null, accountRole: 'owner' })).block).toBe(
      'notMember'
    );
    expect(addRules(ctx({ kind: 'dm' })).block).toBe('dm');
    expect(addRules(ctx({ kind: 'deal_room' })).block).toBe('dealRoom');
    expect(addRules(ctx({ kind: 'team', archived: true })).block).toBe(
      'archived'
    );
    expect(
      addRules(ctx({ kind: 'team', accountRole: 'bank_guest' })).block
    ).toBe('guest');
  });

  it('skips people already in the channel, whatever the id case', () => {
    const c = ctx({ kind: 'team' });
    expect(
      offered(c, [member('ME', 'member'), member('Ann', 'member')])
    ).toEqual(['bob']);
  });
});

describe('canSetRoles / roleChange', () => {
  const roster = [
    member('me', 'admin'),
    member('ann', 'member'),
    member('gus', 'guest'),
  ];
  const full = (o: Partial<ChannelCtx>) => ({
    ...ctx({ myRole: 'admin', ...o }),
    members: roster,
    peopleById: byId,
  });

  it('private needs a channel admin; team also lets a workspace owner/admin', () => {
    expect(canSetRoles(ctx({ myRole: 'admin' }))).toBe(true);
    expect(canSetRoles(ctx({ myRole: 'member', accountRole: 'owner' }))).toBe(
      false
    );
    expect(
      canSetRoles(ctx({ kind: 'team', myRole: null, accountRole: 'admin' }))
    ).toBe(true);
    expect(canSetRoles(ctx({ kind: 'team', myRole: 'member' }))).toBe(false);
    expect(canSetRoles(ctx({ kind: 'dm', myRole: 'admin' }))).toBe(false);
  });

  it('offers make-admin to members, nothing for guests, and blocks demoting the last admin', () => {
    expect(roleChange(roster[1], full({}))).toEqual({
      to: 'admin',
      block: null,
    });
    expect(roleChange(roster[2], full({}))).toBeNull();
    expect(roleChange(roster[0], full({}))).toEqual({
      to: 'member',
      block: 'lastAdmin',
    });
    expect(roleChange(roster[0], full({ kind: 'team' }))).toEqual({
      to: 'member',
      block: null,
    });
  });
});

describe('leaveBlock', () => {
  const base = { kind: 'private' as const, userId: 'me', peopleById: byId };
  it('the last non-guest admin of a private channel cannot leave', () => {
    const members = [member('me', 'admin'), member('ann', 'member')];
    expect(leaveBlock({ ...base, myRole: 'admin', members })).toBe('lastAdmin');
    expect(
      leaveBlock({
        ...base,
        myRole: 'admin',
        members: [...members, member('bob', 'admin')],
      })
    ).toBeNull();
  });

  it('an admin who left the workspace does not count, as in SQL', () => {
    const members = [member('me', 'admin'), member('gone', 'admin')];
    expect(leaveBlock({ ...base, myRole: 'admin', members })).toBe('lastAdmin');
  });

  it('a non-member and the last DM member cannot leave; a team member can', () => {
    expect(leaveBlock({ ...base, myRole: null, members: [] })).toBe(
      'notMember'
    );
    expect(
      leaveBlock({
        ...base,
        kind: 'dm',
        myRole: 'member',
        members: [member('me', 'member')],
      })
    ).toBe('lastMember');
    expect(
      leaveBlock({
        ...base,
        kind: 'team',
        myRole: 'admin',
        members: [member('me', 'admin')],
      })
    ).toBeNull();
  });
});

it('sortMembers: admins, members, guests, by name', () => {
  const sorted = sortMembers(
    [
      member('gus', 'guest'),
      member('bob', 'member'),
      member('me', 'admin'),
      member('ann', 'member'),
    ],
    byId
  ).map((m) => m.userId);
  expect(sorted).toEqual(['me', 'ann', 'bob', 'gus']);
});
