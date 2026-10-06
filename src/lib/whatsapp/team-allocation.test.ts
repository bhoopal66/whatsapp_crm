import { describe, expect, it } from 'vitest';

import {
  effectiveAccess,
  savedAccess,
  teamPeople,
  type TeamRoster,
} from './team-allocation';

const SALES: TeamRoster = {
  id: 'team-sales',
  name: 'Sales',
  leader_user_id: 'lead-1',
  member_ids: ['ana', 'bo'],
};
const SUPPORT: TeamRoster = {
  id: 'team-support',
  name: 'Support',
  leader_user_id: null,
  member_ids: ['bo', 'cy'],
};
const EMPTY: TeamRoster = {
  id: 'team-empty',
  name: 'New team',
  leader_user_id: null,
  member_ids: [],
};
const TEAMS = [SALES, SUPPORT, EMPTY];
const MEMBERS = new Set(['ana', 'bo', 'cy', 'dee', 'lead-1']);

describe('teamPeople', () => {
  it('is the members plus the leader, once each', () => {
    expect(teamPeople(SALES).sort()).toEqual(['ana', 'bo', 'lead-1']);
    expect(
      teamPeople({ ...SALES, member_ids: ['ana', 'lead-1'] }).sort()
    ).toEqual(['ana', 'lead-1']);
    expect(teamPeople(SUPPORT).sort()).toEqual(['bo', 'cy']);
  });
});

describe('effectiveAccess', () => {
  it('with nothing ticked the number is shared', () => {
    const access = effectiveAccess([], [], TEAMS, MEMBERS);
    expect(access.people).toEqual([]);
    expect(access.shared).toBe(true);
    expect(access.teamsEmpty).toBe(false);
  });

  it('direct ticks alone allocate the number', () => {
    const access = effectiveAccess(['dee'], [], TEAMS, MEMBERS);
    expect(access.people).toEqual(['dee']);
    expect(access.viaTeams.size).toBe(0);
    expect(access.shared).toBe(false);
  });

  it('a ticked team brings its members and its leader', () => {
    const access = effectiveAccess([], ['team-sales'], TEAMS, MEMBERS);
    expect(access.people.sort()).toEqual(['ana', 'bo', 'lead-1']);
    expect(access.viaTeams.get('lead-1')).toEqual(['Sales']);
    expect(access.shared).toBe(false);
    expect(access.teamsEmpty).toBe(false);
  });

  it('combines direct ticks with team people, without repeats', () => {
    const access = effectiveAccess(
      ['dee', 'ana'],
      ['team-sales'],
      TEAMS,
      MEMBERS
    );
    expect(access.people.sort()).toEqual(['ana', 'bo', 'dee', 'lead-1']);
    // ana is ticked by hand AND in the team: still marked as via Sales,
    // so the dialog shows why she cannot be unticked.
    expect(access.viaTeams.get('ana')).toEqual(['Sales']);
    expect(access.viaTeams.has('dee')).toBe(false);
  });

  it('names every selected team a person is reached through, in list order', () => {
    const access = effectiveAccess(
      [],
      ['team-support', 'team-sales'],
      TEAMS,
      MEMBERS
    );
    expect(access.viaTeams.get('bo')).toEqual(['Sales', 'Support']);
    expect(access.viaTeams.get('cy')).toEqual(['Support']);
  });

  it('ignores teams that are not ticked', () => {
    const access = effectiveAccess([], ['team-support'], TEAMS, MEMBERS);
    expect(access.viaTeams.has('ana')).toBe(false);
    expect(access.viaTeams.has('lead-1')).toBe(false);
  });

  it('warns when the ticked teams have nobody in them', () => {
    const access = effectiveAccess([], ['team-empty'], TEAMS, MEMBERS);
    expect(access.shared).toBe(true);
    expect(access.teamsEmpty).toBe(true);
  });

  it('an empty team beside a direct tick is not shared, but still flagged', () => {
    const access = effectiveAccess(['dee'], ['team-empty'], TEAMS, MEMBERS);
    expect(access.shared).toBe(false);
    expect(access.teamsEmpty).toBe(true);
  });

  it('leaves out people no longer on the account', () => {
    const access = effectiveAccess(
      ['gone'],
      ['team-sales'],
      [{ ...SALES, member_ids: ['gone-too'], leader_user_id: null }],
      MEMBERS
    );
    expect(access.people).toEqual([]);
    expect(access.shared).toBe(true);
    expect(access.teamsEmpty).toBe(true);
  });
});

describe('savedAccess', () => {
  it('is the direct list plus the team list, once each', () => {
    expect(
      savedAccess({
        member_ids: ['a', 'b'],
        team_ids: ['t'],
        team_member_ids: ['b', 'c'],
      })
    ).toEqual({ people: ['a', 'b', 'c'], shared: false, teamsEmpty: false });
  });

  it('counts a team-only allocation as allocated', () => {
    expect(
      savedAccess({ member_ids: [], team_ids: ['t'], team_member_ids: ['c'] })
        .shared
    ).toBe(false);
  });

  it('flags teams that grant nobody, and stays shared', () => {
    expect(
      savedAccess({ member_ids: [], team_ids: ['t'], team_member_ids: [] })
    ).toEqual({ people: [], shared: true, teamsEmpty: true });
  });

  it('with nothing allocated is plainly shared', () => {
    expect(
      savedAccess({ member_ids: [], team_ids: [], team_member_ids: [] })
    ).toEqual({ people: [], shared: true, teamsEmpty: false });
  });
});
