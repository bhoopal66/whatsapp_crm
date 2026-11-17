import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  result: { data: [] as unknown, error: null as unknown },
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lte', 'eq', 'order', 'limit']) {
    b[m] = (...args: unknown[]) => {
      mocks.calls.push([m, ...args]);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(mocks.result);
  return b;
}

const req = (qs = '') =>
  new Request(`http://localhost/api/team-activity/blocks${qs}`);

describe('GET /api/team-activity/blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.result = { data: [{ id: 'b1' }], error: null };
    mocks.requireRole.mockResolvedValue({
      userId: 'me-1',
      supabase: { from: vi.fn(() => builder()) },
    });
  });

  it('needs the agent role and answers the auth error', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await GET(req());
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(res.status).toBe(403);
  });

  it('returns blocks, newest first, limited to 500', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ blocks: [{ id: 'b1' }] });
    expect(mocks.calls).toContainEqual([
      'order',
      'created_at',
      { ascending: false },
    ]);
    expect(mocks.calls).toContainEqual(['limit', 500]);
  });

  it("mine=1 keeps only the caller's rows; otherwise no user filter", async () => {
    await GET(req('?mine=1'));
    expect(mocks.calls).toContainEqual(['eq', 'user_id', 'me-1']);
    mocks.calls.length = 0;
    await GET(req());
    expect(mocks.calls.some((c) => c[0] === 'eq')).toBe(false);
  });

  it('defaults to the last 7 days', async () => {
    await GET(req());
    const gte = mocks.calls.find((c) => c[0] === 'gte')!;
    const lte = mocks.calls.find((c) => c[0] === 'lte')!;
    const span = Date.parse(lte[2] as string) - Date.parse(gte[2] as string);
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ['an unreadable date', '?from=nope'],
    ['a reversed range', '?from=2026-02-02T00:00:00Z&to=2026-02-01T00:00:00Z'],
    [
      'a range over 92 days',
      '?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z',
    ],
  ])('answers 400 for %s', async (_l, qs) => {
    const res = await GET(req(qs));
    expect(res.status).toBe(400);
    expect(mocks.calls).toEqual([]);
  });

  it('answers 503 when the table is missing', async () => {
    mocks.result = { data: null, error: { code: '42P01', message: 'x' } };
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Unlock requests are not available yet',
    });
  });

  it('answers a generic 500 on other errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.result = { data: null, error: { code: 'XX000', message: 'secret' } };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});
