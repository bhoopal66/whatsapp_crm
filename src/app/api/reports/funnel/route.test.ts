import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Funnel report is owners and admins only (migration 254): the route
// asks requireRole('admin') before any query, validates its parameters,
// and computes the range in the account's zone like /api/team-activity.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

const UUID = '0b5c2a7e-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const url = (q = '') => new Request(`http://localhost/api/reports/funnel${q}`);

function reportReturns(result: { data: unknown; error: unknown }) {
  mocks.rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'team_activity_limits'
        ? { data: [{ timezone: 'Asia/Dubai' }], error: null }
        : result
    )
  );
}

describe('GET /api/reports/funnel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
    });
    reportReturns({
      data: { totals: { new_chats: 4, interested: 2 } },
      error: null,
    });
  });

  it('refuses anyone below admin without querying', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await GET(url());
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    '?range=1y',
    '?lead_source=facebook',
    '?agent=nope',
    '?bank=adcb',
    '?channel=12',
  ])('answers 400 for %s before querying', async (q) => {
    const res = await GET(url(q));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('runs the report in the account zone with the filters', async () => {
    const res = await GET(
      url(
        `?range=7d&lead_source=none&agent=${UUID}&bank=ADCB&channel=${UUID}&tz=Europe/London`
      )
    );
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'funnel_report',
      expect.objectContaining({
        p_tz: 'Asia/Dubai',
        p_lead_source: 'none',
        p_agent: UUID,
        p_bank: 'ADCB',
        p_channel: UUID,
      })
    );
    const body = await res.json();
    expect(body.report.totals.new_chats).toBe(4);
    expect(body.report.totals.approved).toBe(0);
    expect(body.range).toMatchObject({ preset: '7d', tz: 'Asia/Dubai' });
    const args = mocks.rpc.mock.calls.find((c) => c[0] === 'funnel_report')![1];
    expect(Date.parse(args.p_to)).toBeGreaterThan(Date.parse(args.p_from));
  });

  it("falls back to the viewer's zone, then UTC", async () => {
    mocks.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'team_activity_limits'
          ? { data: [], error: null }
          : { data: {}, error: null }
      )
    );
    await GET(url('?tz=Europe/London'));
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      'funnel_report',
      expect.objectContaining({ p_tz: 'Europe/London', p_lead_source: null })
    );
    await GET(url('?tz=%2B04'));
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      'funnel_report',
      expect.objectContaining({ p_tz: 'UTC' })
    );
  });

  it('maps the SQL refusals and a missing function', async () => {
    reportReturns({
      data: null,
      error: { code: '42501', message: 'x', hint: 'NOT_ALLOWED' },
    });
    expect((await GET(url())).status).toBe(403);
    reportReturns({
      data: null,
      error: { code: '22023', message: 'x', hint: 'BAD_RANGE' },
    });
    expect((await GET(url())).status).toBe(400);
    reportReturns({
      data: null,
      error: { code: '22023', message: 'x', hint: 'BAD_FILTER' },
    });
    expect((await GET(url())).status).toBe(400);
    reportReturns({ data: null, error: { code: 'PGRST202', message: 'x' } });
    const missing = await GET(url());
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toMatch(/migration 254/);
    reportReturns({ data: null, error: { code: 'XX000', message: 'x' } });
    expect((await GET(url())).status).toBe(500);
  });
});
