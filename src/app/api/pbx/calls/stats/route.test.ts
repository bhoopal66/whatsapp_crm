import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { GET } from './route';

const NOW = new Date('2026-10-13T10:00:00Z'); // 14:00 in Dubai, a Tuesday
const USER = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const STATS = {
  summary: {
    calls: 3,
    inbound_total: 2,
    inbound_answered: 1,
    answer_rate: 0.5,
  },
  previous: { calls: 1 },
  by_day: [{ day: '2026-10-01', calls: 3 }],
  people: null,
  scope: 'self',
  user_id: null,
};

type Result = {
  data: unknown;
  error: { message: string; code?: string } | null;
};
let zone: Result;
let stats: Result;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  zone = { data: [{ timezone: 'Asia/Dubai' }], error: null };
  stats = { data: STATS, error: null };
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === 'team_activity_limits' ? zone : stats
  );
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc },
    accountId: 'acct-1',
    role: 'agent',
  });
});
afterEach(() => vi.useRealTimers());

const get = (query = '') =>
  GET(new Request(`http://x/api/pbx/calls/stats${query}`));
const statsArgs = () =>
  mocks.rpc.mock.calls.find(([fn]) => fn === 'pbx_call_stats')?.[1];

describe('GET /api/pbx/calls/stats', () => {
  it('is for viewers and up', async () => {
    mocks.requireRole.mockRejectedValueOnce(new Error('forbidden'));
    const res = await get();
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports this month in the account's zone by default", async () => {
    const res = await get('?tz=Asia/Seoul');
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('team_activity_limits', {
      p_account: 'acct-1',
    });
    expect(statsArgs()).toEqual({
      p_from: '2026-09-30T20:00:00.000Z',
      p_to: '2026-10-13T10:00:00.000Z',
      p_tz: 'Asia/Dubai',
      p_user: null,
    });
    const body = await res.json();
    expect(body.range).toEqual({
      period: 'month',
      from: '2026-09-30T20:00:00.000Z',
      to: '2026-10-13T10:00:00.000Z',
      timeZone: 'Asia/Dubai',
    });
    expect(body.stats.summary).toMatchObject({
      calls: 3,
      inboundTotal: 2,
      answerRate: 0.5,
      avgTalkSeconds: null,
    });
    expect(body.stats.previous.calls).toBe(1);
    expect(body.stats.byDay).toHaveLength(1);
    expect(body.stats.people).toBeNull();
    expect(body.stats.scope).toBe('self');
  });

  it("falls back to the viewer's zone when none is saved or it cannot be read", async () => {
    zone = { data: [{ timezone: null }], error: null };
    await get('?period=today&tz=Asia/Seoul');
    // Midnight in Seoul (UTC+9).
    expect(statsArgs()).toMatchObject({
      p_from: '2026-10-12T15:00:00.000Z',
      p_tz: 'Asia/Seoul',
    });

    mocks.rpc.mockClear();
    zone = { data: null, error: { message: 'boom' } };
    const res = await get('?period=week&tz=Asia/Seoul');
    expect(res.status).toBe(200);
    expect(statsArgs()?.p_from).toBe('2026-10-11T15:00:00.000Z');
    expect((await res.json()).range.timeZone).toBe('Asia/Seoul');
  });

  it('takes the periods just gone whole', async () => {
    for (const [period, from, to] of [
      ['yesterday', '2026-10-11T20:00:00.000Z', '2026-10-12T20:00:00.000Z'],
      ['last_week', '2026-10-04T20:00:00.000Z', '2026-10-11T20:00:00.000Z'],
      ['last_month', '2026-08-31T20:00:00.000Z', '2026-09-30T20:00:00.000Z'],
    ]) {
      mocks.rpc.mockClear();
      const res = await get(`?period=${period}`);
      expect(res.status).toBe(200);
      expect(statsArgs()).toMatchObject({ p_from: from, p_to: to });
      expect((await res.json()).range).toMatchObject({ period, from, to });
    }
  });

  it('takes whole custom days and refuses a bad period', async () => {
    const ok = await get('?period=custom&from=2026-10-01&to=2026-10-03');
    expect(ok.status).toBe(200);
    expect(statsArgs()).toMatchObject({
      p_from: '2026-09-30T20:00:00.000Z',
      p_to: '2026-10-03T20:00:00.000Z',
    });

    for (const [query, error] of [
      ['?period=year', 'Unknown period'],
      [
        '?period=custom&from=2026-10-01',
        'A custom period needs from and to dates (YYYY-MM-DD)',
      ],
      [
        '?period=custom&from=2026-10-03&to=2026-10-01',
        'The period ends before it starts',
      ],
      [
        '?period=custom&from=2026-01-01&to=2026-06-01',
        'A custom period spans at most 92 days',
      ],
    ]) {
      mocks.rpc.mockClear();
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
      expect(statsArgs()).toBeUndefined();
    }
  });

  it('narrows to one person, and refuses a user that is not an id', async () => {
    const res = await get(`?period=today&user=${USER}`);
    expect(res.status).toBe(200);
    expect(statsArgs()?.p_user).toBe(USER);

    for (const bad of ['u-1', `${USER}x`, "'; drop table calls"]) {
      mocks.rpc.mockClear();
      const refused = await get(`?user=${encodeURIComponent(bad)}`);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'Unknown person' });
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  });

  it('answers 403 for a person outside the caller’s scope', async () => {
    stats = {
      data: null,
      error: {
        message:
          'You can view only your own calls and those of the teams you lead',
        code: '42501',
      },
    };
    const res = await get(`?user=${USER}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You cannot view that person’s calls',
    });
  });

  it('says when the migration is missing, and hides other database errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stats = { data: null, error: { message: 'nope', code: 'PGRST202' } };
    const missing = await get();
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toMatch(/migration 119/);

    stats = { data: null, error: { message: 'secret detail', code: 'XX000' } };
    const failed = await get();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: 'Failed to load the call report',
    });
    expect(log).toHaveBeenCalledWith(
      '[pbx] call stats failed:',
      'secret detail'
    );

    stats = { data: 'not an object', error: null };
    expect((await get()).status).toBe(500);
    log.mockRestore();
  });
});
