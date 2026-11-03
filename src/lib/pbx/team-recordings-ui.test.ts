import { describe, expect, it } from 'vitest';

import { mergeCalls } from './call-stats-ui';
import {
  averageRecording,
  dayHeading,
  groupRecordingsByDay,
  nextSort,
  numberSearch,
  peopleOfTeam,
  readRecordingsParams,
  recordingsQuery,
  recordingsSearch,
  sortSummary,
  summaryRows,
  type RecordingsParams,
} from './team-recordings-ui';
import type {
  TeamRecordingPerson,
  TeamRecordingSummary,
  TeamRecordingTeam,
} from './team-recordings';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const read = (qs: string) => {
  const p = new URLSearchParams(qs);
  return readRecordingsParams((k) => p.get(k));
};

const DEFAULTS: RecordingsParams = {
  period: 'month',
  from: null,
  to: null,
  team: null,
  user: null,
  direction: 'all',
  minTalk: 0,
  q: null,
};

describe('readRecordingsParams / recordingsSearch', () => {
  it('reads an empty URL as the defaults, and writes them as nothing', () => {
    expect(read('')).toEqual(DEFAULTS);
    expect(recordingsSearch(DEFAULTS)).toBe('');
  });

  it('round-trips every filter', () => {
    const p: RecordingsParams = {
      period: 'custom',
      from: '2026-10-01',
      to: '2026-10-31',
      team: T1,
      user: A,
      direction: 'outbound',
      minTalk: 60,
      q: '97150',
    };
    expect(read(recordingsSearch(p))).toEqual(p);
  });

  it('drops what the route would refuse rather than asking with it', () => {
    expect(
      read('period=decade&team=x&user=1&direction=sideways&minTalk=45&q=12')
    ).toEqual(DEFAULTS);
    expect(read('period=custom&from=2026-10-31&to=2026-10-01')).toEqual({
      ...DEFAULTS,
      period: 'custom',
    });
    expect(read('q=' + '1'.repeat(21)).q).toBeNull();
    expect(read('q=%2B971 50').q).toBe('97150');
  });
});

describe('recordingsQuery', () => {
  it('waits for a custom period’s days', () => {
    expect(recordingsQuery({ ...DEFAULTS, period: 'custom' }, 'UTC')).toBe(
      null
    );
  });

  it('always sends the period and zone, the rest only when set', () => {
    expect(recordingsQuery(DEFAULTS, 'Asia/Dubai')).toBe(
      'period=month&tz=Asia%2FDubai'
    );
    const q = new URLSearchParams(
      recordingsQuery(
        { ...DEFAULTS, user: A, direction: 'inbound', minTalk: 30, q: '555' },
        'UTC',
        `2026-11-03T08:00:00.123456Z|${B}`
      )!
    );
    expect(Object.fromEntries(q)).toEqual({
      period: 'month',
      tz: 'UTC',
      user: A,
      direction: 'inbound',
      minTalk: '30',
      q: '555',
      before: `2026-11-03T08:00:00.123456Z|${B}`,
    });
  });
});

describe('numberSearch', () => {
  it('sends 3 to 20 digits, nothing for an empty box, holds otherwise', () => {
    expect(numberSearch('')).toBe('');
    expect(numberSearch('  - ')).toBe('');
    expect(numberSearch('05')).toBeNull();
    expect(numberSearch('+971 50 1')).toBe('971501');
    expect(numberSearch('1'.repeat(21))).toBeNull();
  });
});

const people: TeamRecordingPerson[] = [
  { userId: A, name: 'Amal', role: 'agent', teamIds: [T1] },
  { userId: B, name: 'Bilal', role: 'agent', teamIds: [] },
  { userId: C, name: null, role: 'team_leader', teamIds: [T1] },
];
const teams: TeamRecordingTeam[] = [
  { id: T1, name: 'Sales', memberIds: [A, C] },
];

describe('peopleOfTeam', () => {
  it('lists a team’s members, everyone without a team, nobody for an unknown one', () => {
    expect(peopleOfTeam(people, teams, T1).map((p) => p.userId)).toEqual([
      A,
      C,
    ]);
    expect(peopleOfTeam(people, teams, null)).toHaveLength(3);
    expect(peopleOfTeam(people, teams, B)).toEqual([]);
  });
});

const sum = (
  userId: string,
  recorded: number,
  recordedSeconds: number,
  lastRecordedAt: string | null = null
): TeamRecordingSummary => ({
  userId,
  calls: recorded + 1,
  answered: recorded,
  recorded,
  recordedSeconds,
  longestSeconds: recordedSeconds,
  lastRecordedAt,
});

describe('summary rows', () => {
  it('averages per recorded call, null with none', () => {
    expect(averageRecording(sum(A, 3, 100))).toBe(33);
    expect(averageRecording(sum(A, 0, 0))).toBeNull();
  });

  it('joins names and team names', () => {
    const rows = summaryRows([sum(A, 2, 60), sum(B, 0, 0)], people, teams);
    expect(rows[0]).toMatchObject({
      name: 'Amal',
      teamNames: ['Sales'],
      avgSeconds: 30,
    });
    expect(rows[1]).toMatchObject({ name: 'Bilal', teamNames: [] });
  });

  it('sorts high-first, missing figures last either way, ties by name', () => {
    const rows = summaryRows(
      [
        sum(A, 2, 60, '2026-11-01T10:00:00Z'),
        sum(B, 0, 0),
        sum(C, 2, 300, '2026-11-02T10:00:00Z'),
      ],
      people,
      teams
    );
    const ids = (key: Parameters<typeof sortSummary>[1], dir: 'asc' | 'desc') =>
      sortSummary(rows, key, dir).map((r) => r.userId);
    expect(ids('recorded', 'desc')).toEqual([A, C, B]);
    expect(ids('recordedSeconds', 'desc')).toEqual([C, A, B]);
    expect(ids('avgSeconds', 'asc')).toEqual([A, C, B]);
    expect(ids('avgSeconds', 'desc')).toEqual([C, A, B]);
    expect(ids('lastRecordedAt', 'desc')).toEqual([C, A, B]);
    expect(ids('name', 'asc')).toEqual([A, B, C]);
    expect(ids('name', 'desc')).toEqual([B, A, C]);
  });

  it('flips the same column and starts another high-first', () => {
    expect(nextSort({ key: 'recorded', dir: 'desc' }, 'recorded')).toEqual({
      key: 'recorded',
      dir: 'asc',
    });
    expect(nextSort({ key: 'recorded', dir: 'desc' }, 'calls')).toEqual({
      key: 'calls',
      dir: 'desc',
    });
    expect(nextSort({ key: 'calls', dir: 'desc' }, 'name')).toEqual({
      key: 'name',
      dir: 'asc',
    });
  });
});

describe('the list', () => {
  const call = (id: string, startedAt: string) => ({ id, startedAt });

  it('groups by the day in the zone, not in UTC', () => {
    const calls = [
      call('1', '2026-11-02T21:00:00Z'), // 3 Nov 01:00 in Dubai
      call('2', '2026-11-02T19:00:00Z'), // 2 Nov 23:00 in Dubai
      call('3', '2026-11-02T08:00:00Z'),
    ];
    expect(
      groupRecordingsByDay(calls, 'Asia/Dubai').map((d) => [
        d.key,
        d.items.map((c) => c.id),
      ])
    ).toEqual([
      ['2026-11-03', ['1']],
      ['2026-11-02', ['2', '3']],
    ]);
    expect(groupRecordingsByDay(calls, 'UTC')).toHaveLength(1);
  });

  it('names a day like "Tue 3 Nov"', () => {
    expect(dayHeading('2026-11-03', 'en-GB')).toBe('Tue 3 Nov');
  });

  it('appends a page without repeating a call', () => {
    const first = [call('1', 'a'), call('2', 'b')];
    expect(
      mergeCalls(first, [call('2', 'b'), call('3', 'c')]).map((c) => c.id)
    ).toEqual(['1', '2', '3']);
  });
});
