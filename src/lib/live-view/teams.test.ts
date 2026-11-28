import { describe, expect, it } from 'vitest';

import {
  filterLivePeople,
  LIVE_ALL_TEAMS,
  liveTeamOptions,
  showLiveTeamFilter,
  type LivePerson,
} from './view';

const person = (userId: string): LivePerson => ({
  userId,
  name: userId,
  role: 'agent',
  presence: 'online',
  lastSeenAt: null,
  openChats: 0,
  waitingChats: 0,
  oldestWaitingSince: null,
  oldestWaitingBusinessMinutes: null,
  repliesToday: 0,
});

const rows = [
  {
    id: 't2',
    name: 'Sales B',
    leader_user_id: 'lead',
    team_members: [{ user_id: 'b1' }],
  },
  {
    id: 't1',
    name: 'Sales A',
    leader_user_id: 'other-lead',
    team_members: [{ user_id: 'a1' }, { user_id: 'a2' }, null],
  },
  { name: 'no id' },
  null,
];

describe('liveTeamOptions', () => {
  it('gives owners and admins every team, sorted, with the leader counted', () => {
    const teams = liveTeamOptions(rows, 'admin', 'all');
    expect(teams.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(teams[0].memberIds.sort()).toEqual(['a1', 'a2', 'other-lead']);
  });

  it('gives a team leader only the teams they lead', () => {
    expect(liveTeamOptions(rows, 'lead', 'team').map((t) => t.id)).toEqual([
      't2',
    ]);
    expect(liveTeamOptions(rows, null, 'team')).toEqual([]);
  });

  it('reads nothing from a bad answer', () => {
    expect(liveTeamOptions(null, 'admin', 'all')).toEqual([]);
    expect(liveTeamOptions({}, 'admin', 'all')).toEqual([]);
  });
});

describe('showLiveTeamFilter', () => {
  const one = liveTeamOptions(rows.slice(0, 1), 'lead', 'all');
  const two = liveTeamOptions(rows, 'admin', 'all');
  it('offers the filter to admins from one team, to leaders from two', () => {
    expect(showLiveTeamFilter([], 'all')).toBe(false);
    expect(showLiveTeamFilter(one, 'all')).toBe(true);
    expect(showLiveTeamFilter(one, 'team')).toBe(false);
    expect(showLiveTeamFilter(two, 'team')).toBe(true);
  });
});

describe('filterLivePeople', () => {
  const teams = liveTeamOptions(rows, 'admin', 'all');
  const people = ['b1', 'a2', 'x', 'a1', 'other-lead'].map(person);

  it('keeps everyone for all teams or a team that is gone', () => {
    expect(filterLivePeople(people, teams, LIVE_ALL_TEAMS)).toHaveLength(5);
    expect(filterLivePeople(people, teams, 'deleted')).toHaveLength(5);
  });

  it('keeps one team, leader included, in the original order', () => {
    expect(filterLivePeople(people, teams, 't1').map((p) => p.userId)).toEqual([
      'a2',
      'a1',
      'other-lead',
    ]);
  });
});
