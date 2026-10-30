import { describe, expect, it } from 'vitest';

import {
  audienceChanged,
  audienceMinRole,
  audienceRoleOption,
  audienceSummary,
  channelRuleActions,
  filterTeams,
  isAnnouncementChannel,
  isRestrictedAudience,
  policyChanges,
  type ChannelPolicy,
} from '../channel-rules';

const TEAMS = [
  { id: 't1', name: 'Sales' },
  { id: 't2', name: 'Support' },
  { id: 't3', name: 'Ops' },
];

describe('channelRuleActions', () => {
  const base = {
    kind: 'team' as const,
    archived: false,
    myRole: 'admin' as const,
    accountRole: 'agent',
  };

  it('offers both on a team channel to its admin', () => {
    expect(channelRuleActions(base)).toEqual({ policy: true, audience: true });
  });

  it('offers only posting permissions on a private channel', () => {
    expect(channelRuleActions({ ...base, kind: 'private' })).toEqual({
      policy: true,
      audience: false,
    });
  });

  it('offers nothing on a DM, a deal room or an archived channel', () => {
    const none = { policy: false, audience: false };
    expect(channelRuleActions({ ...base, kind: 'dm' })).toEqual(none);
    expect(channelRuleActions({ ...base, kind: 'deal_room' })).toEqual(none);
    expect(channelRuleActions({ ...base, archived: true })).toEqual(none);
  });

  it('follows the manage gate: plain members no, workspace admins yes', () => {
    expect(channelRuleActions({ ...base, myRole: 'member' }).policy).toBe(
      false
    );
    expect(
      channelRuleActions({ ...base, myRole: null, accountRole: 'admin' })
    ).toEqual({ policy: true, audience: true });
    // A private channel needs membership, owners and admins included.
    expect(
      channelRuleActions({
        ...base,
        kind: 'private',
        myRole: null,
        accountRole: 'owner',
      }).policy
    ).toBe(false);
  });
});

describe('policyChanges', () => {
  const stored: ChannelPolicy = {
    posting: 'everyone',
    threadReplies: 'everyone',
    mentionEveryone: 'admins',
  };

  it('is null when nothing changed', () => {
    expect(policyChanges(stored, { ...stored })).toBeNull();
  });

  it('sends only the changed fields', () => {
    expect(
      policyChanges(stored, {
        ...stored,
        posting: 'admins',
        mentionEveryone: 'everyone',
      })
    ).toEqual({ posting: 'admins', mentionEveryone: 'everyone' });
  });
});

it('isAnnouncementChannel reads the posting rule', () => {
  expect(isAnnouncementChannel({ posting: 'admins' })).toBe(true);
  expect(isAnnouncementChannel({ posting: 'everyone' })).toBe(false);
});

describe('audience role option', () => {
  it('reads a stored viewer floor (and null) as all staff', () => {
    expect(audienceRoleOption(null)).toBe('all');
    expect(audienceRoleOption('viewer')).toBe('all');
    expect(audienceRoleOption('team_leader')).toBe('team_leader');
    expect(audienceRoleOption('bogus')).toBe('all');
  });

  it('saves all staff as null and the rest as themselves', () => {
    expect(audienceMinRole('all')).toBeNull();
    expect(audienceMinRole('agent')).toBe('agent');
  });
});

describe('audienceChanged', () => {
  const stored = { role: 'agent' as const, teamIds: ['t1', 't2'] };

  it('ignores team order', () => {
    expect(audienceChanged(stored, { ...stored, teamIds: ['t2', 't1'] })).toBe(
      false
    );
  });

  it('sees a role or team change', () => {
    expect(audienceChanged(stored, { ...stored, role: 'all' })).toBe(true);
    expect(audienceChanged(stored, { ...stored, teamIds: ['t1'] })).toBe(true);
    expect(audienceChanged(stored, { ...stored, teamIds: ['t1', 't3'] })).toBe(
      true
    );
  });
});

describe('audienceSummary', () => {
  it('is everyone with no floor and no teams', () => {
    expect(audienceSummary({ role: 'all', teamIds: [] }, TEAMS)).toEqual({
      kind: 'everyone',
    });
  });

  it('is owners and admins only at the admin floor, teams or not', () => {
    expect(audienceSummary({ role: 'admin', teamIds: ['t1'] }, TEAMS)).toEqual({
      kind: 'adminsOnly',
    });
  });

  it('names the role floor and the chosen teams in list order', () => {
    expect(
      audienceSummary({ role: 'team_leader', teamIds: ['t2', 't1'] }, TEAMS)
    ).toEqual({
      kind: 'restricted',
      role: 'team_leader',
      teams: ['Sales', 'Support'],
    });
    expect(audienceSummary({ role: 'all', teamIds: ['t3'] }, TEAMS)).toEqual({
      kind: 'restricted',
      role: 'all',
      teams: ['Ops'],
    });
  });

  it('leaves out ids with no known name', () => {
    expect(
      audienceSummary({ role: 'agent', teamIds: ['gone', 't1'] }, TEAMS)
    ).toEqual({ kind: 'restricted', role: 'agent', teams: ['Sales'] });
  });
});

it('isRestrictedAudience: a floor or any team', () => {
  expect(isRestrictedAudience({ role: 'all', teamIds: [] })).toBe(false);
  expect(isRestrictedAudience({ role: 'agent', teamIds: [] })).toBe(true);
  expect(isRestrictedAudience({ role: 'all', teamIds: ['t1'] })).toBe(true);
});

it('filterTeams matches names case-insensitively', () => {
  expect(filterTeams(TEAMS, ' SU ').map((t) => t.id)).toEqual(['t2']);
  expect(filterTeams(TEAMS, '')).toHaveLength(3);
});
