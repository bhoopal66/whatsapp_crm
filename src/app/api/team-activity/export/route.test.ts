import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Team activity CSV is the owner's alone ("Only owner can do
// this"): requireRole('owner') refuses everyone else before any query.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'forbidden' }, { status: 403 })
  ),
}));

import { GET } from './route';

const REPORT = {
  tz: 'UTC',
  senders: [
    {
      kind: 'person',
      user_id: 'u1',
      name: 'Agent One',
      email: 'one@example.com',
      chats_started: 3,
    },
  ],
  numbers: [{ channel_id: 'w1', provider: 'whapi', label: 'Sales' }],
};

describe('GET /api/team-activity/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'team_activity_limits'
          ? { data: [], error: null }
          : { data: REPORT, error: null }
      )
    );
  });

  it('refuses anyone below owner without querying', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));

    const res = await GET(
      new Request('http://localhost/api/team-activity/export?range=7d')
    );

    expect(mocks.requireRole).toHaveBeenCalledWith('owner');
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('gives the owner the people table as a CSV attachment', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
    });

    const res = await GET(
      new Request(
        'http://localhost/api/team-activity/export?range=30d&tz=UTC&table=people'
      )
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/csv/);
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="team-activity-people-30d-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    const text = await res.text();
    expect(text).toContain('"Agent One"');
    expect(mocks.rpc).toHaveBeenCalledWith(
      'team_activity_report',
      expect.objectContaining({ p_tz: 'UTC', p_channel_id: null })
    );
  });

  it('gives the numbers table', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
    });

    const res = await GET(
      new Request('http://localhost/api/team-activity/export?table=numbers')
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"Sales"');
  });

  it('rejects an unknown table or range', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
    });

    const bad = await GET(
      new Request('http://localhost/api/team-activity/export?table=daily')
    );
    expect(bad.status).toBe(400);
    const badRange = await GET(
      new Request('http://localhost/api/team-activity/export?range=1y')
    );
    expect(badRange.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers 503 when the report function is missing', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
    });
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'x' },
    });

    const res = await GET(
      new Request('http://localhost/api/team-activity/export')
    );
    expect(res.status).toBe(503);
  });
});
