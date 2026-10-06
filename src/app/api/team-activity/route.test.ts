import { beforeEach, describe, expect, it, vi } from 'vitest';

// Team activity is open to team leaders (migration 074): the route lets
// them in and the SQL report decides the scope. Settings and the Safety
// Meter stay admin-only in their own routes.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

describe('GET /api/team-activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'team_activity_limits'
          ? { data: [], error: null }
          : { data: { senders: [], numbers: [] }, error: null }
      )
    );
  });

  it('admits team leaders and up', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
    });

    const res = await GET(
      new Request('http://localhost/api/team-activity?range=7d&tz=UTC')
    );

    expect(mocks.requireRole).toHaveBeenCalledWith('team_leader');
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'team_activity_report',
      expect.objectContaining({ p_tz: 'UTC', p_channel_id: null })
    );
  });

  it('answers the auth error without querying when the role is too low', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));

    const res = await GET(new Request('http://localhost/api/team-activity'));

    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
