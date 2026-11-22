import { beforeEach, describe, expect, it, vi } from 'vitest';

// Any signed-in staff member reaches the route; chat_tag_report()
// (migration 255) decides who opens it, and its NOT_ALLOWED refusal is
// the 403.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET as EXPORT } from './export/route';
import { GET } from './route';

const REPORT = {
  history_since: '2026-11-22T08:00:00Z',
  tags: [
    { id: 't1', parent_id: null, name: 'New', color: '#000', position: 0 },
  ],
  current: [{ tag_id: 't1', sub_tag_id: null, chats: 3 }],
};

function answer(report: { data: unknown; error: unknown }, zone?: string) {
  mocks.rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'team_activity_limits'
        ? { data: zone ? [{ timezone: zone }] : [], error: null }
        : report
    )
  );
}

const req = (path: string) => new Request(`http://localhost${path}`);

describe('GET /api/reports/tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
      role: 'agent',
    });
    answer({ data: REPORT, error: null });
  });

  it('admits any staff member and lets the SQL decide', async () => {
    const res = await GET(req('/api/reports/tags?range=7d&tz=Asia/Dubai'));

    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.tags[0].name).toBe('New');
    expect(body.range).toMatchObject({ preset: '7d', tz: 'Asia/Dubai' });
    expect(body.canManageAccess).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'chat_tag_report',
      expect.objectContaining({ p_tz: 'Asia/Dubai' })
    );
  });

  it("uses the account's saved zone over the viewer's", async () => {
    answer({ data: REPORT, error: null }, 'Europe/London');
    const res = await GET(req('/api/reports/tags?range=today&tz=Asia/Dubai'));
    expect((await res.json()).range.tz).toBe('Europe/London');
  });

  it('falls back to UTC for an unknown viewer zone', async () => {
    const res = await GET(req('/api/reports/tags?tz=Not/AZone'));
    const body = await res.json();
    expect(body.range).toMatchObject({ preset: '30d', tz: 'UTC' });
  });

  it('tells the owner they manage access', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
      role: 'owner',
    });
    const res = await GET(req('/api/reports/tags'));
    expect((await res.json()).canManageAccess).toBe(true);
  });

  it('refuses an unknown range before any query', async () => {
    const res = await GET(req('/api/reports/tags?range=forever'));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers NOT_ALLOWED as 403', async () => {
    answer({
      data: null,
      error: { code: '42501', message: 'no', hint: 'NOT_ALLOWED' },
    });
    const res = await GET(req('/api/reports/tags'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('not_allowed');
  });

  it('answers a missing function as 503 and anything else as 500', async () => {
    answer({ data: null, error: { code: 'PGRST202', message: 'x' } });
    expect((await GET(req('/api/reports/tags'))).status).toBe(503);
    answer({ data: null, error: { code: 'XX000', message: 'x' } });
    expect((await GET(req('/api/reports/tags'))).status).toBe(500);
  });

  it('answers the auth error without querying', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await GET(req('/api/reports/tags'));
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/tags/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
      role: 'viewer',
    });
    answer({ data: REPORT, error: null });
  });

  it('downloads a CSV', async () => {
    const res = await EXPORT(req('/api/reports/tags/export?range=7d'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="chat-tag-report-7d-\d{4}-\d{2}-\d{2}\.csv"/
    );
    const text = await res.text();
    expect(text).toContain('"Section","Main tag"');
    expect(text).toContain('"New","No sub-tag","","","3"');
  });

  it('answers NOT_ALLOWED as 403', async () => {
    answer({
      data: null,
      error: { code: '42501', message: 'no', hint: 'NOT_ALLOWED' },
    });
    expect((await EXPORT(req('/api/reports/tags/export'))).status).toBe(403);
  });
});
