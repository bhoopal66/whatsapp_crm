import { describe, expect, it } from 'vitest';
import { ACCOUNT_ROLES } from '@/lib/auth/roles';
import {
  canCreateGroup,
  canManageGroup,
  canSyncGroups,
  canViewGroup,
  groupActionBlock,
} from './access';

const g = { createdBy: 'u1', managerIds: ['u2'], channelId: 'c1' };

describe('canViewGroup', () => {
  it('admin and owner see every group', () => {
    for (const role of ['admin', 'owner'] as const) {
      expect(
        canViewGroup({
          role,
          userId: 'x',
          group: { createdBy: null, managerIds: [] },
        })
      ).toBe(true);
    }
  });
  it('creator and manager see it; strangers do not; guest never', () => {
    for (const role of ['viewer', 'agent', 'team_leader'] as const) {
      expect(canViewGroup({ role, userId: 'u1', group: g })).toBe(true);
      expect(canViewGroup({ role, userId: 'u2', group: g })).toBe(true);
      expect(canViewGroup({ role, userId: 'u9', group: g })).toBe(false);
    }
    expect(canViewGroup({ role: 'bank_guest', userId: 'u1', group: g })).toBe(
      false
    );
  });
  it('a team leader sees groups made or managed by people they lead', () => {
    const args = { role: 'team_leader' as const, userId: 'L', group: g };
    expect(canViewGroup({ ...args, ledTeamMemberIds: ['u1'] })).toBe(true);
    expect(canViewGroup({ ...args, ledTeamMemberIds: ['u2'] })).toBe(true);
    expect(canViewGroup({ ...args, ledTeamMemberIds: ['u7'] })).toBe(false);
  });
  it('an agent does not gain sight from led-team ids', () => {
    expect(
      canViewGroup({
        role: 'agent',
        userId: 'L',
        group: g,
        ledTeamMemberIds: ['u1'],
      })
    ).toBe(false);
  });
});

describe('canManageGroup', () => {
  const usable = ['c1'];
  it('admin and owner always, even with no number', () => {
    expect(
      canManageGroup({
        role: 'admin',
        userId: 'x',
        group: { ...g, channelId: null },
        usableChannelIds: [],
      })
    ).toBe(true);
  });
  it('agent and leader: creator or manager on a usable number', () => {
    for (const role of ['agent', 'team_leader'] as const) {
      const base = { role, group: g, usableChannelIds: usable };
      expect(canManageGroup({ ...base, userId: 'u1' })).toBe(true);
      expect(canManageGroup({ ...base, userId: 'u2' })).toBe(true);
      expect(canManageGroup({ ...base, userId: 'u9' })).toBe(false);
      expect(
        canManageGroup({ ...base, userId: 'u1', usableChannelIds: [] })
      ).toBe(false);
      expect(
        canManageGroup({
          ...base,
          userId: 'u1',
          group: { ...g, channelId: null },
        })
      ).toBe(false);
    }
  });
  it('viewer and guest never', () => {
    for (const role of ['viewer', 'bank_guest'] as const) {
      expect(
        canManageGroup({
          role,
          userId: 'u1',
          group: g,
          usableChannelIds: ['c1'],
        })
      ).toBe(false);
    }
  });
});

describe('canCreateGroup / canSyncGroups', () => {
  it('agent and up on a usable number', () => {
    expect(
      ACCOUNT_ROLES.filter((r) => canCreateGroup(r, 'c1', ['c1'])).sort()
    ).toEqual(['admin', 'agent', 'owner', 'team_leader']);
    expect(canCreateGroup('agent', 'c2', ['c1'])).toBe(false);
    expect(canCreateGroup('agent', null, ['c1'])).toBe(false);
  });
  it('sync is admin and up', () => {
    expect(ACCOUNT_ROLES.filter((r) => canSyncGroups(r)).sort()).toEqual([
      'admin',
      'owner',
    ]);
  });
});

describe('groupActionBlock', () => {
  const base = {
    role: 'agent' as const,
    userId: 'u1',
    group: { ...g, ourRole: 'admin' as const },
    usableChannelIds: ['c1'],
  };
  it('null when allowed', () => {
    expect(groupActionBlock({ ...base, adminOnly: true })).toBeNull();
  });
  it('not_allowed for a stranger, viewer or unusable number', () => {
    expect(groupActionBlock({ ...base, userId: 'u9' })).toBe('not_allowed');
    expect(groupActionBlock({ ...base, role: 'viewer' })).toBe('not_allowed');
    expect(groupActionBlock({ ...base, usableChannelIds: [] })).toBe(
      'not_allowed'
    );
  });
  it('number_removed when the number is gone', () => {
    expect(
      groupActionBlock({ ...base, group: { ...base.group, channelId: null } })
    ).toBe('number_removed');
    expect(
      groupActionBlock({
        ...base,
        role: 'admin',
        group: { ...base.group, channelId: null },
      })
    ).toBe('number_removed');
  });
  it('left beats not_group_admin', () => {
    expect(
      groupActionBlock({
        ...base,
        adminOnly: true,
        group: { ...base.group, ourRole: 'left' },
      })
    ).toBe('left');
  });
  it('not_group_admin only for admin-only actions', () => {
    const member = { ...base.group, ourRole: 'member' as const };
    expect(groupActionBlock({ ...base, group: member })).toBeNull();
    expect(groupActionBlock({ ...base, group: member, adminOnly: true })).toBe(
      'not_group_admin'
    );
  });
});
