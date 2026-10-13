import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ROLES,
  ASSIGNABLE_ROLES,
  STAFF_ROLES,
  type AccountRole,
  canDeleteAccount,
  canLeadTeam,
  canManageTeams,
  canEditSettings,
  canGrantRole,
  canInviteMembers,
  canManageMembers,
  canSendMessages,
  grantableRoles,
  canTransferOwnership,
  canViewOnly,
  hasMinRole,
  isBankGuest,
  isAccountRole,
  roleRank,
} from './roles';

describe('roleRank', () => {
  it('orders owner > admin > agent > viewer', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('agent'));
    expect(roleRank('agent')).toBeGreaterThan(roleRank('viewer'));
  });

  it("matches the SQL helper's numeric mapping", () => {
    // Keep these in lockstep with `is_account_member`'s CASE
    // expression — most recently rewritten in migration 044, which
    // inserted `team_leader` between agent and admin and pushed the
    // two ranks above it up by one.
    expect(roleRank('owner')).toBe(5);
    expect(roleRank('admin')).toBe(4);
    expect(roleRank('team_leader')).toBe(3);
    expect(roleRank('agent')).toBe(2);
    expect(roleRank('viewer')).toBe(1);
  });
});

describe('hasMinRole', () => {
  it('returns true when role meets the threshold', () => {
    expect(hasMinRole('owner', 'viewer')).toBe(true);
    expect(hasMinRole('admin', 'agent')).toBe(true);
    expect(hasMinRole('agent', 'agent')).toBe(true);
  });

  it('returns false when role is below the threshold', () => {
    expect(hasMinRole('viewer', 'agent')).toBe(false);
    expect(hasMinRole('agent', 'admin')).toBe(false);
    expect(hasMinRole('admin', 'owner')).toBe(false);
  });

  // The full matrix — useful as a regression net if anyone reshuffles
  // the rank table.
  it.each<[AccountRole, AccountRole, boolean]>([
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'agent', true],
    ['owner', 'viewer', true],
    ['admin', 'owner', false],
    ['admin', 'admin', true],
    ['admin', 'agent', true],
    ['admin', 'viewer', true],
    ['agent', 'owner', false],
    ['agent', 'admin', false],
    ['agent', 'agent', true],
    ['agent', 'viewer', true],
    ['viewer', 'owner', false],
    ['viewer', 'admin', false],
    ['viewer', 'agent', false],
    ['viewer', 'viewer', true],
  ])('%s vs min %s → %s', (role, min, expected) => {
    expect(hasMinRole(role, min)).toBe(expected);
  });
});

describe('isAccountRole', () => {
  it('accepts every value in ACCOUNT_ROLES', () => {
    for (const role of ACCOUNT_ROLES) {
      expect(isAccountRole(role)).toBe(true);
    }
  });

  it('rejects garbage / case mismatch / non-strings', () => {
    expect(isAccountRole('Owner')).toBe(false);
    expect(isAccountRole('')).toBe(false);
    expect(isAccountRole(null)).toBe(false);
    expect(isAccountRole(undefined)).toBe(false);
    expect(isAccountRole(123)).toBe(false);
    expect(isAccountRole('superuser')).toBe(false);
  });
});

describe('capability predicates', () => {
  it('canManageMembers: admin+ only', () => {
    expect(canManageMembers('owner')).toBe(true);
    expect(canManageMembers('admin')).toBe(true);
    expect(canManageMembers('agent')).toBe(false);
    expect(canManageMembers('viewer')).toBe(false);
  });

  it('canEditSettings: admin+ only', () => {
    expect(canEditSettings('owner')).toBe(true);
    expect(canEditSettings('admin')).toBe(true);
    expect(canEditSettings('agent')).toBe(false);
    expect(canEditSettings('viewer')).toBe(false);
  });

  it('canSendMessages: agent+ only', () => {
    expect(canSendMessages('owner')).toBe(true);
    expect(canSendMessages('admin')).toBe(true);
    expect(canSendMessages('agent')).toBe(true);
    expect(canSendMessages('viewer')).toBe(false);
  });

  it('canViewOnly: viewer only', () => {
    expect(canViewOnly('owner')).toBe(false);
    expect(canViewOnly('admin')).toBe(false);
    expect(canViewOnly('agent')).toBe(false);
    expect(canViewOnly('viewer')).toBe(true);
  });

  it('canDeleteAccount: owner only', () => {
    expect(canDeleteAccount('owner')).toBe(true);
    expect(canDeleteAccount('admin')).toBe(false);
    expect(canDeleteAccount('agent')).toBe(false);
    expect(canDeleteAccount('viewer')).toBe(false);
  });

  it('canTransferOwnership: owner only', () => {
    expect(canTransferOwnership('owner')).toBe(true);
    expect(canTransferOwnership('admin')).toBe(false);
    expect(canTransferOwnership('agent')).toBe(false);
    expect(canTransferOwnership('viewer')).toBe(false);
  });
});

describe('ASSIGNABLE_ROLES', () => {
  // Create-login, invite and the roster's role change all render this
  // list; team_leader used to be missing from two of them.
  it('is every role but owner, highest first, team_leader included', () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(
      STAFF_ROLES.filter((r) => r !== 'owner').reverse()
    );
    expect(ASSIGNABLE_ROLES).toContain('team_leader');
  });

  it('never offers bank_guest: a guest is added with a bank code, not assigned', () => {
    expect(ASSIGNABLE_ROLES).not.toContain('bank_guest');
  });
});

describe('bank_guest (migrations 082/083)', () => {
  it('ranks below viewer, at 0, like current_role_rank()', () => {
    expect(roleRank('bank_guest')).toBe(0);
    expect(ACCOUNT_ROLES[0]).toBe('bank_guest');
    expect(hasMinRole('bank_guest', 'viewer')).toBe(false);
  });

  it('is the only role outside STAFF_ROLES', () => {
    expect(
      ACCOUNT_ROLES.filter(
        (r) => !(STAFF_ROLES as readonly string[]).includes(r)
      )
    ).toEqual(['bank_guest']);
    expect(isAccountRole('bank_guest')).toBe(true);
  });

  it('isBankGuest is true for the guest only', () => {
    expect(ACCOUNT_ROLES.filter((r) => isBankGuest(r))).toEqual(['bank_guest']);
    expect(isBankGuest(null)).toBe(false);
    expect(isBankGuest(undefined)).toBe(false);
  });

  it('holds no capability', () => {
    for (const can of [
      canManageMembers,
      canEditSettings,
      canSendMessages,
      canViewOnly,
      canDeleteAccount,
      canTransferOwnership,
      canLeadTeam,
      canManageTeams,
      canInviteMembers,
    ]) {
      expect(can('bank_guest'), can.name).toBe(false);
    }
  });
});

// Module 014's matrix: a supervisor (team_leader) invites RMs/agents;
// changing roles, removing and deactivating stay admin+ (099).
describe('adding people (migration 099)', () => {
  it('canInviteMembers: team leader and up', () => {
    expect(ACCOUNT_ROLES.filter((r) => canInviteMembers(r))).toEqual([
      'team_leader',
      'admin',
      'owner',
    ]);
  });

  it('a team leader still does not manage the roster', () => {
    expect(canManageMembers('team_leader')).toBe(false);
  });

  it('owner and admin may grant every role but owner', () => {
    for (const caller of ['owner', 'admin'] as const) {
      expect(ACCOUNT_ROLES.filter((r) => canGrantRole(caller, r))).toEqual([
        'bank_guest',
        'viewer',
        'agent',
        'team_leader',
        'admin',
      ]);
    }
  });

  it('a team leader may grant only agent and viewer', () => {
    expect(ACCOUNT_ROLES.filter((r) => canGrantRole('team_leader', r))).toEqual(
      ['viewer', 'agent']
    );
  });

  it('agents, viewers and bank guests may grant nothing', () => {
    for (const caller of ['agent', 'viewer', 'bank_guest'] as const) {
      expect(ACCOUNT_ROLES.filter((r) => canGrantRole(caller, r))).toEqual([]);
    }
  });

  it('grantableRoles narrows a picker list, keeping its order', () => {
    expect(grantableRoles('team_leader', ASSIGNABLE_ROLES)).toEqual([
      'agent',
      'viewer',
    ]);
    expect(grantableRoles('admin', ASSIGNABLE_ROLES)).toEqual([
      ...ASSIGNABLE_ROLES,
    ]);
    expect(grantableRoles('agent', ASSIGNABLE_ROLES)).toEqual([]);
    expect(grantableRoles(null, ASSIGNABLE_ROLES)).toEqual([]);
  });
});
