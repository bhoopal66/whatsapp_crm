import { describe, expect, it } from 'vitest';
import {
  RECORDING_DIRECTIONS,
  TALK_FILTERS,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  narrowPeople,
  parseTeamRecordingsQuery,
  scopePeople,
  summarizeRecordings,
  utcInstant,
  type TeamRecordingsQuery,
} from './team-recordings';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CALL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const parse = (query: string) =>
  parseTeamRecordingsQuery(new URLSearchParams(query));
const ok = (query: string) => {
  const q = parse(query);
  if (typeof q === 'string') throw new Error(q);
  return q as TeamRecordingsQuery;
};

describe('parseTeamRecordingsQuery', () => {
  it('defaults to this month, every direction, any length, a page of 50', () => {
    expect(ok('')).toEqual({
      period: 'month',
      from: null,
      to: null,
      tz: null,
      team: null,
      user: null,
      direction: 'all',
      minTalk: 0,
      q: null,
      before: null,
      limit: 50,
    });
  });

  it('takes every filter', () => {
    const q = ok(
      `period=custom&from=2026-10-01&to=2026-10-03&tz=Asia/Dubai&team=${T1}&user=${A}&direction=outbound&minTalk=180&q=%2B971%2055-823&before=${encodeURIComponent(`2026-10-02T08:00:00.123456Z|${CALL}`)}&limit=100`
    );
    expect(q).toMatchObject({
      period: 'custom',
      from: '2026-10-01',
      to: '2026-10-03',
      tz: 'Asia/Dubai',
      team: T1,
      user: A,
      direction: 'outbound',
      minTalk: 180,
      q: '97155823',
      before: { at: '2026-10-02T08:00:00.123456Z', id: CALL },
      limit: 100,
    });
    for (const d of RECORDING_DIRECTIONS)
      expect(ok(`direction=${d}`).direction).toBe(d);
    for (const t of TALK_FILTERS) expect(ok(`minTalk=${t}`).minTalk).toBe(t);
    expect(ok('minTalk=36000').minTalk).toBe(36000);
    expect(ok('q=%20%20').q).toBeNull();
  });

  it.each([
    ['period=year', 'Unknown period'],
    ['team=nope', 'team must be an id'],
    ['user=1', 'user must be an id'],
    [
      'direction=external',
      'direction must be one of all, inbound, outbound, internal',
    ],
    ['minTalk=-1', /minTalk/],
    ['minTalk=1.5', /minTalk/],
    ['minTalk=36001', /minTalk/],
    ['minTalk=abc', /minTalk/],
    ['q=12', /3 to 20 digits/],
    ['q=abc', /3 to 20 digits/],
    ['q=123456789012345678901', /3 to 20 digits/],
    ['before=junk', 'before is not a page cursor'],
    ['limit=0', /limit/],
    ['limit=101', /limit/],
    ['limit=ten', /limit/],
  ])('refuses %s', (query, error) => {
    const q = parse(query);
    expect(typeof q).toBe('string');
    if (typeof error === 'string') expect(q).toBe(error);
    else expect(q).toMatch(error);
  });
});

describe('page cursor', () => {
  it('round-trips a call, microseconds and all, in UTC without a plus', () => {
    const c = encodeCursor({
      started_at: '2026-10-02T12:00:00.123456+04:00',
      id: CALL,
    });
    expect(c).toBe(`2026-10-02T08:00:00.123456Z|${CALL}`);
    expect(decodeCursor(c)).toEqual({
      at: '2026-10-02T08:00:00.123456Z',
      id: CALL,
    });
    expect(
      decodeCursor(
        encodeCursor({ started_at: '2026-10-02T08:00:00+00:00', id: CALL })
      )
    ).toEqual({ at: '2026-10-02T08:00:00Z', id: CALL });
  });

  it('refuses junk', () => {
    for (const junk of [
      '',
      'x|y',
      `2026-10-02T08:00:00Z`,
      `2026-10-02T08:00:00Z|${CALL}|x`,
      `2026-10-02|${CALL}`,
      `2026-10-02T08:00:00Z|not-a-uuid`,
      `2026-13-45T08:00:00Z|${CALL}`,
      `2026-10-02T08:00:00Z),id.gt.(|${CALL}`,
    ])
      expect(decodeCursor(junk)).toBeNull();
    expect(utcInstant('yesterday')).toBeNull();
  });

  it('filters strictly older calls in the list order', () => {
    expect(cursorFilter({ at: '2026-10-02T08:00:00.5Z', id: CALL })).toBe(
      `started_at.lt."2026-10-02T08:00:00.5Z",and(started_at.eq."2026-10-02T08:00:00.5Z",id.lt.${CALL})`
    );
  });
});

describe('scopePeople and narrowPeople', () => {
  const scope = scopePeople({
    profiles: [
      { user_id: B, full_name: 'Zara', account_role: 'agent' },
      { user_id: A, full_name: ' Ali ', account_role: 'team_leader' },
      { user_id: C, full_name: null, account_role: 'agent' },
      { user_id: 'guest', full_name: 'Bank', account_role: 'bank_guest' },
    ],
    visibleIds: [A, B, 'guest'],
    teams: [
      { id: T2, name: 'Sales' },
      { id: T1, name: 'Cards' },
    ],
    memberships: [
      { team_id: T1, user_id: B },
      { team_id: T1, user_id: C },
      { team_id: T2, user_id: A },
      { team_id: 'other', user_id: B },
    ],
  });

  it('keeps visible live staff, sorted, with teams in scope only', () => {
    expect(scope.people).toEqual([
      { userId: A, name: 'Ali', role: 'team_leader', teamIds: [T2] },
      { userId: B, name: 'Zara', role: 'agent', teamIds: [T1] },
    ]);
    expect(scope.teams).toEqual([
      { id: T1, name: 'Cards', memberIds: [B] },
      { id: T2, name: 'Sales', memberIds: [A] },
    ]);
  });

  it('an admin (no visible list) sees everyone but guests', () => {
    const all = scopePeople({
      profiles: [
        { user_id: C, full_name: null, account_role: 'agent' },
        { user_id: A, full_name: 'Ali', account_role: 'admin' },
      ],
      visibleIds: null,
      teams: [],
      memberships: [],
    });
    expect(all.people.map((p) => p.userId)).toEqual([A, C]);
  });

  it('narrows to a team, then a person, and refuses outside the scope', () => {
    expect(narrowPeople(scope, { team: null, user: null })).toEqual({
      ok: true,
      userIds: [A, B],
    });
    expect(narrowPeople(scope, { team: T1, user: null })).toEqual({
      ok: true,
      userIds: [B],
    });
    expect(narrowPeople(scope, { team: T1, user: A })).toEqual({
      ok: true,
      userIds: [],
    });
    expect(narrowPeople(scope, { team: null, user: B })).toEqual({
      ok: true,
      userIds: [B],
    });
    expect(narrowPeople(scope, { team: CALL, user: null }).ok).toBe(false);
    expect(narrowPeople(scope, { team: null, user: C }).ok).toBe(false);
  });
});

describe('summarizeRecordings', () => {
  it('counts every attributed call, fetched recordings only, zero rows kept', () => {
    const row = (
      user_id: string | null,
      recording_state: string,
      talk_seconds: number | null,
      started_at: string,
      answered = true
    ) => ({
      user_id,
      recording_state,
      talk_seconds,
      started_at,
      answered_at: answered ? started_at : null,
    });
    expect(
      summarizeRecordings(
        [A, B, C],
        [
          row(A, 'fetched', 120, '2026-10-02T08:00:00Z'),
          row(A, 'fetched', 300, '2026-10-03T08:00:00.5Z'),
          row(A, 'pending', 900, '2026-10-04T08:00:00Z'),
          row(A, 'none', null, '2026-10-05T08:00:00Z', false),
          row(B, 'held', 60, '2026-10-02T08:00:00Z'),
          row(null, 'fetched', 60, '2026-10-02T08:00:00Z'),
          row('outsider', 'fetched', 60, '2026-10-02T08:00:00Z'),
        ]
      )
    ).toEqual([
      {
        userId: A,
        calls: 4,
        answered: 3,
        recorded: 2,
        recordedSeconds: 420,
        longestSeconds: 300,
        lastRecordedAt: '2026-10-03T08:00:00.5Z',
      },
      {
        userId: B,
        calls: 1,
        answered: 1,
        recorded: 0,
        recordedSeconds: 0,
        longestSeconds: 0,
        lastRecordedAt: null,
      },
      {
        userId: C,
        calls: 0,
        answered: 0,
        recorded: 0,
        recordedSeconds: 0,
        longestSeconds: 0,
        lastRecordedAt: null,
      },
    ]);
  });
});
