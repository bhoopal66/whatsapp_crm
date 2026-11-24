import { beforeEach, describe, expect, it, vi } from 'vitest';

// The dashboard CSV is the owner's alone ("Only owner can do this"):
// requireRole('owner') refuses everyone else before any query.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'forbidden' }, { status: 403 })
  ),
}));

import { GET } from './route';

/** A PostgREST builder stand-in: every filter returns itself, awaiting gives `result`. */
function builder(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'eq', 'or', 'order']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return b;
}

function ownerClient() {
  mocks.rpc.mockImplementation((fn: string) => {
    switch (fn) {
      case 'dashboard_message_series':
        return Promise.resolve({ data: [], error: null });
      case 'dashboard_response_time':
        return Promise.resolve({ data: [], error: null });
      case 'dashboard_open_deal_values':
        return Promise.resolve({
          data: [
            {
              stage_id: 's1',
              currency: 'AED',
              deal_count: 2,
              total_value: 300,
            },
          ],
          error: null,
        });
      case 'team_activity_limits':
        return Promise.resolve({ data: [], error: null });
      case 'team_activity_report':
        return Promise.resolve({
          data: { senders: [], numbers: [] },
          error: null,
        });
      default:
        return Promise.resolve({ data: null, error: { message: fn } });
    }
  });
  mocks.from.mockImplementation((table: string) => {
    if (table === 'pipeline_stages') {
      return builder({
        data: [{ id: 's1', name: 'Qualified', color: '#000' }],
        error: null,
      });
    }
    if (table === 'whatsapp_config') {
      return builder({
        data: [{ id: 'n1', status: 'connected' }],
        error: null,
      });
    }
    // broadcasts
    return builder({ data: [], count: 0, error: null });
  });
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc, from: mocks.from },
    accountId: 'account-1',
  });
}

describe('GET /api/dashboard/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses anyone below owner without querying', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));

    const res = await GET(new Request('http://localhost/api/dashboard/export'));

    expect(mocks.requireRole).toHaveBeenCalledWith('owner');
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('gives the owner the figures as a CSV attachment', async () => {
    ownerClient();

    const res = await GET(
      new Request('http://localhost/api/dashboard/export?tz=Asia/Dubai')
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/csv/);
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="dashboard-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    const text = await res.text();
    expect(text).toContain('"Deals in Qualified","Now","2"');
    expect(text).toContain('"Connected","Now","1"');
    expect(text).toContain('"Time zone","","Asia/Dubai"');
    expect(mocks.rpc).toHaveBeenCalledWith(
      'dashboard_message_series',
      expect.objectContaining({ p_tz: 'Asia/Dubai' })
    );
  });

  it('falls back to UTC for an unknown zone', async () => {
    ownerClient();

    const res = await GET(
      new Request('http://localhost/api/dashboard/export?tz=Not/AZone')
    );

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'dashboard_message_series',
      expect.objectContaining({ p_tz: 'UTC' })
    );
  });

  it('answers 500 when a figure fails to load', async () => {
    ownerClient();
    const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation((fn: string, args: unknown) =>
      fn === 'dashboard_response_time'
        ? Promise.resolve({ data: null, error: { message: 'boom' } })
        : base(fn, args)
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(new Request('http://localhost/api/dashboard/export'));

    expect(res.status).toBe(500);
  });
});
