import { beforeEach, describe, expect, it, vi } from 'vitest';

// The CSV export takes the same parameters and the same owner/admin gate
// as /api/reports/funnel, and answers through lib/csv/build.ts.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(
    async ({ namespace }: { namespace: string }) =>
      (key: string) =>
        `${namespace}.${key}`
  ),
}));

import { GET } from './route';

const url = (q = '') =>
  new Request(`http://localhost/api/reports/funnel/export${q}`);

describe('GET /api/reports/funnel/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
    });
    mocks.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'team_activity_limits'
          ? { data: [], error: null }
          : {
              data: {
                totals: { new_chats: 3, interested: 1 },
                by_source: [{ key: 'ad', new_chats: 3 }],
                by_agent: [{ key: null, name: '=HYPERLINK("x")' }],
              },
              error: null,
            }
      )
    );
  });

  it('refuses anyone below admin without querying', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await GET(url());
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad parameter', async () => {
    const res = await GET(url('?bank=lower'));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('downloads a CSV attachment', async () => {
    const res = await GET(url('?range=7d'));
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/csv/);
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="funnel-report-7d-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    const body = await res.text();
    const lines = body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('"FunnelReport.csv.breakdown"');
    expect(lines[1]).toBe(
      '"FunnelReport.csv.total","FunnelReport.csv.all","3","1","0","0","0","0","0"'
    );
    expect(body).toContain('"ContactsTable.source.ad"');
    // Formula cells are neutralised by buildCsv.
    expect(body).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
