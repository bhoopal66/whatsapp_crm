import { describe, expect, it } from 'vitest';
import { ACCOUNT_ROLES } from '@/lib/auth/roles';
import {
  canCreateGroup,
  canManageGroup,
  canSyncGroups,
  canViewGroup,
  groupActionBlock,
  groupAddBlock,
  isGroupCapableNumber,
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
  it('admin and owner always, even with no number', () => {
    expect(
      canManageGroup({
        role: 'admin',
        userId: 'x',
        group: { ...g, channelId: null },
      })
    ).toBe(true);
  });
  it('agent and leader: creator or manager while the group has a number', () => {
    for (const role of ['agent', 'team_leader'] as const) {
      const base = { role, group: g };
      expect(canManageGroup({ ...base, userId: 'u1' })).toBe(true);
      expect(canManageGroup({ ...base, userId: 'u2' })).toBe(true);
      expect(canManageGroup({ ...base, userId: 'u9' })).toBe(false);
      expect(
        canManageGroup({
          ...base,
          userId: 'u1',
          group: { ...g, channelId: null },
        })
      ).toBe(false);
    }
  });
  // 218: appointing a manager is the grant for the group; the number
  // being allocated to other people (not usable by the manager for 1:1
  // chats or creating groups) does not take it away.
  it('a manager on a number allocated to other people manages it', () => {
    const onAllocated = {
      createdBy: 'admin1',
      managerIds: ['u2'],
      channelId: 'c2',
    };
    for (const role of ['agent', 'team_leader'] as const) {
      expect(canManageGroup({ role, userId: 'u2', group: onAllocated })).toBe(
        true
      );
      expect(canManageGroup({ role, userId: 'u9', group: onAllocated })).toBe(
        false
      );
    }
    // Creating a group there stays with the people the number is on.
    expect(canCreateGroup('agent', 'c2', ['c1'])).toBe(false);
  });
  it('viewer and guest never', () => {
    for (const role of ['viewer', 'bank_guest'] as const) {
      expect(canManageGroup({ role, userId: 'u1', group: g })).toBe(false);
      expect(canManageGroup({ role, userId: 'u2', group: g })).toBe(false);
    }
  });
});

describe('isGroupCapableNumber (208)', () => {
  it('Whapi and company OpenWA, never personal OpenWA or Meta', () => {
    expect(
      isGroupCapableNumber({ provider: 'whapi', is_personal: false })
    ).toBe(true);
    expect(
      isGroupCapableNumber({ provider: 'openwa', is_personal: false })
    ).toBe(true);
    expect(
      isGroupCapableNumber({ provider: 'openwa', is_personal: true })
    ).toBe(false);
    expect(isGroupCapableNumber({ provider: 'meta', is_personal: false })).toBe(
      false
    );
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
  };
  it('null when allowed', () => {
    expect(groupActionBlock({ ...base, adminOnly: true })).toBeNull();
  });
  it('null for a manager on a number allocated to other people (218)', () => {
    const group = {
      createdBy: 'admin1',
      managerIds: ['u2'],
      channelId: 'c2',
      ourRole: 'admin' as const,
    };
    for (const adminOnly of [false, true]) {
      expect(
        groupActionBlock({ ...base, userId: 'u2', group, adminOnly })
      ).toBeNull();
    }
  });
  it('not_allowed for a stranger or a viewer, manager or not', () => {
    expect(groupActionBlock({ ...base, userId: 'u9' })).toBe('not_allowed');
    expect(groupActionBlock({ ...base, role: 'viewer' })).toBe('not_allowed');
    expect(groupActionBlock({ ...base, role: 'viewer', userId: 'u2' })).toBe(
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

describe('groupAddBlock', () => {
  const g = (
    over: Partial<{
      channelId: string | null;
      ourRole: 'admin' | 'member' | 'left';
    }> = {}
  ) => ({ channelId: 'ch-1', ourRole: 'admin' as const, ...over });

  it('lets every staff member at agent level and up add, managers or not', () => {
    for (const role of ['agent', 'team_leader', 'admin', 'owner'] as const) {
      expect(groupAddBlock({ role, group: g() })).toBeNull();
    }
  });

  it('refuses viewers and bank guests', () => {
    expect(groupAddBlock({ role: 'viewer', group: g() })).toBe('not_allowed');
    expect(groupAddBlock({ role: 'bank_guest', group: g() })).toBe(
      'not_allowed'
    );
  });

  it('still needs a connected number on which we are a group admin', () => {
    expect(
      groupAddBlock({ role: 'agent', group: g({ channelId: null }) })
    ).toBe('number_removed');
    expect(
      groupAddBlock({ role: 'agent', group: g({ ourRole: 'left' }) })
    ).toBe('left');
    expect(
      groupAddBlock({ role: 'agent', group: g({ ourRole: 'member' }) })
    ).toBe('not_group_admin');
  });
});
