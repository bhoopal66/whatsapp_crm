import { describe, expect, it } from 'vitest';

import {
  TEAM_NAME_MAX,
  allocationStaysShared,
  buildTeamPatch,
  draftOf,
  initialsOf,
  isEmptyPatch,
  membershipElsewhere,
  pickableMembers,
  searchMembers,
  summarizeTeams,
  teamNameProblem,
  unassignedMembers,
  type Team,
  type TeamDraft,
  type TeamPerson,
} from './teams';

function team(over: Partial<Team> & { id: string }): Team {
  return {
    name: over.id,
    leader_user_id: null,
    created_at: '2026-10-01T00:00:00Z',
    member_ids: [],
    channel_ids: [],
    ...over,
  };
}

function person(user_id: string, over: Partial<TeamPerson> = {}): TeamPerson {
  return {
    user_id,
    full_name: user_id,
    email: `${user_id}@example.com`,
    role: 'agent',
    deactivated_at: null,
    ...over,
  };
}

describe('buildTeamPatch', () => {
  const original = team({
    id: 't1',
    name: 'Sales',
    leader_user_id: 'lead',
    member_ids: ['a', 'b'],
    channel_ids: ['n1'],
  });

  it('is empty when nothing changed', () => {
    expect(buildTeamPatch(original, draftOf(original))).toEqual({});
    expect(isEmptyPatch(buildTeamPatch(original, draftOf(original)))).toBe(
      true
    );
  });

  it('treats lists as sets: reordering or re-ticking is no change', () => {
    const draft = { ...draftOf(original), member_ids: ['b', 'a', 'a'] };
    expect(buildTeamPatch(original, draft)).toEqual({});
  });

  // Numbers & access owns a team's numbers. The route hands update_team
  // NULL for an absent channel_ids, which leaves the allocation alone;
  // sending the editor's copy would overwrite a change made there since
  // the Teams screen loaded.
  it('never sends channel_ids, so a save keeps the team numbers', () => {
    const stale = { ...original, channel_ids: [] };
    const draft = {
      ...draftOf(original),
      member_ids: ['a'],
      channel_ids: ['n1', 'n2'],
    } as TeamDraft;
    expect(buildTeamPatch(original, draft)).toEqual({ member_ids: ['a'] });
    expect(buildTeamPatch(stale, draftOf(original))).toEqual({});
    expect('channel_ids' in draftOf(original)).toBe(false);
  });

  it('sends only the members when only members changed, de-duplicated', () => {
    const draft = { ...draftOf(original), member_ids: ['a', 'c', 'c'] };
    expect(buildTeamPatch(original, draft)).toEqual({
      member_ids: ['a', 'c'],
    });
  });

  it('clears the leader with an explicit null', () => {
    const draft = { ...draftOf(original), leader_user_id: null };
    expect(buildTeamPatch(original, draft)).toEqual({ leader_user_id: null });
  });

  it('compares and sends the name trimmed', () => {
    expect(
      buildTeamPatch(original, { ...draftOf(original), name: '  Sales ' })
    ).toEqual({});
    expect(
      buildTeamPatch(original, { ...draftOf(original), name: ' Sales UAE ' })
    ).toEqual({ name: 'Sales UAE' });
  });

  it('carries every changed field together', () => {
    const draft = {
      name: 'Support',
      leader_user_id: 'b',
      member_ids: ['a'],
    };
    expect(buildTeamPatch(original, draft)).toEqual(draft);
  });

  it('does not alias the original team through draftOf', () => {
    const draft = draftOf(original);
    draft.member_ids.push('z');
    expect(original.member_ids).toEqual(['a', 'b']);
  });
});

describe('teamNameProblem', () => {
  it('requires a non-blank name within the route limit', () => {
    expect(teamNameProblem('   ')).toBe('required');
    expect(teamNameProblem('x'.repeat(TEAM_NAME_MAX))).toBeNull();
    expect(teamNameProblem(` ${'x'.repeat(TEAM_NAME_MAX)} `)).toBeNull();
    expect(teamNameProblem('x'.repeat(TEAM_NAME_MAX + 1))).toBe('tooLong');
  });
});

describe('allocationStaysShared', () => {
  const base = { name: 'T', leader_user_id: null, member_ids: [] };

  it('warns only when a team with numbers has nobody in it', () => {
    expect(allocationStaysShared(['n1'], base)).toBe(true);
    expect(allocationStaysShared([], base)).toBe(false);
    expect(allocationStaysShared(['n1'], { ...base, member_ids: ['a'] })).toBe(
      false
    );
  });

  it('counts the leader as someone in the team', () => {
    expect(
      allocationStaysShared(['n1'], { ...base, leader_user_id: 'lead' })
    ).toBe(false);
  });
});

describe('membershipElsewhere', () => {
  const teams = [
    team({ id: 'sales', member_ids: ['a', 'b'] }),
    team({ id: 'support', member_ids: ['c'], leader_user_id: 'd' }),
  ];

  it('maps each member of another team to that team', () => {
    const held = membershipElsewhere(teams, 'sales');
    expect(held.get('c')?.id).toBe('support');
    expect(held.has('a')).toBe(false);
  });

  it('does not treat leading a team as membership', () => {
    expect(membershipElsewhere(teams, 'sales').has('d')).toBe(false);
  });

  it('covers every team when no team is excluded', () => {
    expect([...membershipElsewhere(teams, null).keys()].sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('summaries', () => {
  const members = [
    person('owner', { role: 'owner' }),
    person('admin', { role: 'admin' }),
    person('lead', { role: 'team_leader' }),
    person('a'),
    person('b'),
    person('loose'),
    person('gone', { deactivated_at: '2026-09-01T00:00:00Z' }),
  ];
  const teams = [
    team({ id: 'sales', leader_user_id: 'lead', member_ids: ['a', 'lead'] }),
    team({ id: 'support', member_ids: ['b', 'ghost'] }),
  ];

  it('lists active non-admins who are in no team and lead none', () => {
    expect(unassignedMembers(teams, members).map((m) => m.user_id)).toEqual([
      'loose',
    ]);
  });

  it('counts distinct known people in teams, leaders included', () => {
    expect(summarizeTeams(teams, members)).toEqual({
      teams: 2,
      inTeams: 3,
      unassigned: 1,
    });
  });

  it('a leader of a team they are not a member of is placed', () => {
    const only = [team({ id: 'x', leader_user_id: 'loose' })];
    expect(unassignedMembers(only, members).map((m) => m.user_id)).toEqual([
      'lead',
      'a',
      'b',
    ]);
    expect(summarizeTeams(only, members).inTeams).toBe(1);
  });
});

describe('pickableMembers / searchMembers', () => {
  const members = [
    person('u1', { full_name: 'zara Khan', email: 'zara@acme.io' }),
    person('u2', { full_name: 'Ali Hassan', email: 'ali@acme.io' }),
    person('u3', {
      full_name: 'Old Timer',
      deactivated_at: '2026-01-01T00:00:00Z',
    }),
  ];

  it('drops deactivated people unless they are already selected', () => {
    expect(pickableMembers(members, []).map((m) => m.user_id)).toEqual([
      'u2',
      'u1',
    ]);
    expect(pickableMembers(members, ['u3']).map((m) => m.user_id)).toEqual([
      'u2',
      'u3',
      'u1',
    ]);
  });

  it('matches name or email, case-insensitively', () => {
    expect(searchMembers(members, 'ZARA').map((m) => m.user_id)).toEqual([
      'u1',
    ]);
    expect(searchMembers(members, 'ali@').map((m) => m.user_id)).toEqual([
      'u2',
    ]);
    expect(searchMembers(members, '  ')).toHaveLength(3);
    expect(searchMembers(members, 'nobody')).toEqual([]);
  });
});

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Sara Ali Khan')).toBe('SK');
    expect(initialsOf('sara')).toBe('S');
    expect(initialsOf('  ')).toBe('?');
    expect(initialsOf('김 민수')).toBe('김민');
  });
});
