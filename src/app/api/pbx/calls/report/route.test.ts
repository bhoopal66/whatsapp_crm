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
const ROWS = [
  {
    row_kind: 'person',
    user_id: 'u-1',
    full_name: 'Sara',
    extension: '101',
    inbound_answered: 2,
    outbound: 1,
    missed: 1,
    talk_seconds: 150,
    talk_calls: 3,
    ring_seconds: 30,
    ring_calls: 2,
    outcomes: { interested: 1, none: 2 },
  },
  { row_kind: 'none', user_id: null, missed: 1, outcomes: {} },
  { row_kind: 'total', user_id: null, inbound_answered: 2, missed: 2 },
];

let zone: { data: unknown; error: { message: string; code?: string } | null };
let report: { data: unknown; error: { message: string; code?: string } | null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  zone = { data: [{ timezone: 'Asia/Dubai' }], error: null };
  report = { data: ROWS, error: null };
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === 'team_activity_limits' ? zone : report
  );
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc },
    accountId: 'acct-1',
    role: 'team_leader',
  });
});
afterEach(() => vi.useRealTimers());

const get = (query = '') =>
  GET(new Request(`http://x/api/pbx/calls/report${query}`));
const reportArgs = () =>
  mocks.rpc.mock.calls.find(([fn]) => fn === 'pbx_call_report')?.[1];

describe('GET /api/pbx/calls/report', () => {
  it('is for team leaders and up', async () => {
    mocks.requireRole.mockRejectedValueOnce(new Error('forbidden'));
    const res = await get();
    expect(mocks.requireRole).toHaveBeenCalledWith('team_leader');
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports this month in the account's zone by default", async () => {
    const res = await get('?tz=Asia/Seoul');
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('team_activity_limits', {
      p_account: 'acct-1',
    });
    expect(reportArgs()).toEqual({
      p_from: '2026-09-30T20:00:00.000Z',
      p_to: '2026-10-13T10:00:00.000Z',
    });
    const body = await res.json();
    expect(body.range).toEqual({
      period: 'month',
      from: '2026-09-30T20:00:00.000Z',
      to: '2026-10-13T10:00:00.000Z',
      timeZone: 'Asia/Dubai',
    });
    expect(body.report.people).toHaveLength(1);
    expect(body.report.people[0]).toMatchObject({
      userId: 'u-1',
      name: 'Sara',
      inboundAnswered: 2,
      outcomes: { interested: 1, none: 2, call_back: 0 },
    });
    expect(body.report.unattributed.missed).toBe(1);
    expect(body.report.total.missed).toBe(2);
  });

  it("falls back to the viewer's zone when none is saved or it cannot be read", async () => {
    zone = { data: [{ timezone: null }], error: null };
    await get('?period=today&tz=Asia/Seoul');
    // Midnight in Seoul (UTC+9).
    expect(reportArgs()?.p_from).toBe('2026-10-12T15:00:00.000Z');

    mocks.rpc.mockClear();
    zone = { data: null, error: { message: 'boom' } };
    const res = await get('?period=week&tz=Asia/Seoul');
    expect(res.status).toBe(200);
    expect(reportArgs()?.p_from).toBe('2026-10-11T15:00:00.000Z');
    expect((await res.json()).range.timeZone).toBe('Asia/Seoul');
  });

  it('takes whole custom days and refuses a bad period', async () => {
    const ok = await get('?period=custom&from=2026-10-01&to=2026-10-03');
    expect(ok.status).toBe(200);
    expect(reportArgs()).toEqual({
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
      expect(reportArgs()).toBeUndefined();
    }
  });

  it('says when the migration is missing, and hides other database errors', async () => {
    report = { data: null, error: { message: 'nope', code: 'PGRST202' } };
    const missing = await get();
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toMatch(/migration 098/);

    report = { data: null, error: { message: 'secret detail', code: 'XX000' } };
    const failed = await get();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: 'Failed to load the call report',
    });
  });
});
