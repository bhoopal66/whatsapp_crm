import { describe, expect, it } from 'vitest';

import { liveTeamsCacheKey } from '@/lib/client-cache';

import {
  ALL_TEAMS,
  filterLivePeople,
  normalizeSelection,
  selectableTeams,
  type LiveTeam,
} from './team-filter';

const TEAMS: LiveTeam[] = [
  { id: 't-b', name: 'Beta', leaderUserId: 'lead-2', memberIds: ['b1', 'b2'] },
  {
    id: 't-a',
    name: 'Alpha',
    leaderUserId: 'lead-1',
    memberIds: ['a1', 'a2', 'shared'],
  },
  // 'shared' in two teams: still one row.
  { id: 't-c', name: 'Gamma', leaderUserId: 'lead-1', memberIds: ['shared'] },
];

const person = (userId: string) => ({ userId });
const WORKSPACE = [
  'a1',
  'a2',
  'b1',
  'b2',
  'shared',
  'lead-1',
  'lead-2',
  'loner',
].map(person);
const ids = (rows: { userId: string }[]) => rows.map((r) => r.userId);

describe('selectableTeams', () => {
  it('offers a leader only the teams they lead', () => {
    expect(
      selectableTeams(TEAMS, 'lead-1', 'team_leader').map((t) => t.id)
    ).toEqual(['t-a', 't-c']);
  });

  it('offers an admin and an owner every team, by name', () => {
    expect(selectableTeams(TEAMS, 'x', 'admin').map((t) => t.id)).toEqual([
      't-a',
      't-b',
      't-c',
    ]);
    expect(selectableTeams(TEAMS, 'x', 'owner')).toHaveLength(3);
  });

  it('offers nothing below team leader or without a viewer', () => {
    expect(selectableTeams(TEAMS, 'lead-1', 'agent')).toEqual([]);
    expect(selectableTeams(TEAMS, 'lead-1', null)).toEqual([]);
    expect(selectableTeams(TEAMS, null, 'team_leader')).toEqual([]);
  });
});

describe('filterLivePeople', () => {
  const leader = { userId: 'lead-1', role: 'team_leader' as const };
  const admin = { userId: 'adm', role: 'admin' as const };

  it('a leader sees only their teams people and themselves', () => {
    const mine = selectableTeams(TEAMS, 'lead-1', 'team_leader');
    expect(ids(filterLivePeople(WORKSPACE, mine, ALL_TEAMS, leader))).toEqual([
      'a1',
      'a2',
      'shared',
      'lead-1',
    ]);
  });

  it('a leader picking one team sees that team and its leader', () => {
    const mine = selectableTeams(TEAMS, 'lead-1', 'team_leader');
    expect(ids(filterLivePeople(WORKSPACE, mine, 't-c', leader))).toEqual([
      'shared',
      'lead-1',
    ]);
  });

  it('a leader cannot pick a team they do not lead: it means all of theirs', () => {
    const mine = selectableTeams(TEAMS, 'lead-1', 'team_leader');
    expect(ids(filterLivePeople(WORKSPACE, mine, 't-b', leader))).toEqual(
      ids(filterLivePeople(WORKSPACE, mine, ALL_TEAMS, leader))
    );
  });

  it('"all teams" for an admin keeps everyone, including people in no team', () => {
    const all = selectableTeams(TEAMS, 'adm', 'admin');
    expect(ids(filterLivePeople(WORKSPACE, all, ALL_TEAMS, admin))).toEqual(
      ids(WORKSPACE)
    );
  });

  it('an admin can pick any team', () => {
    const all = selectableTeams(TEAMS, 'adm', 'admin');
    expect(ids(filterLivePeople(WORKSPACE, all, 't-b', admin))).toEqual([
      'b1',
      'b2',
      'lead-2',
    ]);
  });

  it('a person in two teams appears once', () => {
    const all = selectableTeams(TEAMS, 'lead-1', 'team_leader');
    const doubled = [...WORKSPACE, person('shared')];
    const out = ids(filterLivePeople(doubled, all, ALL_TEAMS, leader));
    expect(out.filter((id) => id === 'shared')).toHaveLength(1);
    const adminOut = ids(
      filterLivePeople(
        doubled,
        selectableTeams(TEAMS, 'a', 'admin'),
        'all',
        admin
      )
    );
    expect(adminOut.filter((id) => id === 'shared')).toHaveLength(1);
  });

  it('never returns someone the view did not hand over', () => {
    const all = selectableTeams(TEAMS, 'adm', 'admin');
    expect(ids(filterLivePeople([person('a1')], all, 't-b', admin))).toEqual(
      []
    );
  });
});

describe('normalizeSelection', () => {
  it('falls back to all for an unknown team', () => {
    expect(normalizeSelection('gone', TEAMS)).toBe(ALL_TEAMS);
    expect(normalizeSelection('t-a', TEAMS)).toBe('t-a');
  });
});

describe('liveTeamsCacheKey', () => {
  it('names the workspace, the viewer and the scope', () => {
    expect(liveTeamsCacheKey('acc', 'u1', 'all')).not.toBe(
      liveTeamsCacheKey('acc', 'u1', 'led')
    );
    expect(liveTeamsCacheKey('acc', 'u1', 'led')).not.toBe(
      liveTeamsCacheKey('acc', 'u2', 'led')
    );
    expect(liveTeamsCacheKey('acc', 'u1', 'led')).not.toBe(
      liveTeamsCacheKey('acc2', 'u1', 'led')
    );
  });
});
