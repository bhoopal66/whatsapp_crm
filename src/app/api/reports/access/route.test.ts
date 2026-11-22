import { beforeEach, describe, expect, it, vi } from 'vitest';

// Report access (migration 255) is the owner's alone: the route asks
// for the owner role and the SQL refuses anyone else as well.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET, PUT } from './route';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const url = (q = '?report=chat_tags') =>
  `http://localhost/api/reports/access${q}`;
const put = (body: unknown, q?: string) =>
  new Request(url(q), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('/api/reports/access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
      accountId: 'account-1',
      role: 'owner',
    });
  });

  it('lists people for the owner', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ user_id: U1, name: 'Sara', role: 'agent', granted: true }],
      error: null,
    });
    const res = await GET(new Request(url()));
    expect(mocks.requireRole).toHaveBeenCalledWith('owner');
    expect(mocks.rpc).toHaveBeenCalledWith('report_access_list', {
      p_report: 'chat_tags',
    });
    expect((await res.json()).people).toEqual([
      {
        userId: U1,
        name: 'Sara',
        role: 'agent',
        granted: true,
        grantedAt: null,
      },
    ]);
  });

  it('refuses an unknown report', async () => {
    expect((await GET(new Request(url('?report=funnel')))).status).toBe(400);
    expect((await PUT(put({ userIds: [] }, '?report=x'))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('refuses anyone but the owner without querying', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await GET(new Request(url()))).status).toBe(403);
    expect((await PUT(put({ userIds: [] }))).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('saves the exact set, deduped', async () => {
    mocks.rpc.mockResolvedValue({ data: 2, error: null });
    const res = await PUT(put({ userIds: [U1, U2, U1.toUpperCase()] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
    expect(mocks.rpc).toHaveBeenCalledWith('report_access_set', {
      p_report: 'chat_tags',
      p_users: [U1, U2],
    });
  });

  it('accepts an empty list (nobody but the owner)', async () => {
    mocks.rpc.mockResolvedValue({ data: 0, error: null });
    expect((await PUT(put({ userIds: [] }))).status).toBe(200);
  });

  it.each([
    ['not JSON', '{'],
    ['no list', {}],
    ['not ids', { userIds: ['me'] }],
    ['not strings', { userIds: [1] }],
    ['too many', { userIds: Array.from({ length: 501 }, () => U1) }],
  ])('refuses a bad body (%s)', async (_label, body) => {
    expect((await PUT(put(body))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers BAD_USERS as 400, NOT_ALLOWED as 403, missing as 503', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'x', hint: 'BAD_USERS' },
    });
    expect((await PUT(put({ userIds: [U1] }))).status).toBe(400);
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'x', hint: 'NOT_ALLOWED' },
    });
    expect((await GET(new Request(url()))).status).toBe(403);
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'x' },
    });
    expect((await GET(new Request(url()))).status).toBe(503);
  });
});
