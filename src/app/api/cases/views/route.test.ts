import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
// The real CaseViews over a fake rpc: the route, the lib and the status table together.
vi.mock('@/lib/cases/server', async () => {
  const { CaseViews } = await import('@/lib/cases/views');
  return {
    caseViews: () =>
      new CaseViews(
        { rpc: m.rpc } as never,
        () => new Date('2026-11-10T09:00:00Z')
      ),
  };
});

import { UnauthorizedError } from '@/lib/auth/account';
import { GET, POST } from './route';
import { DELETE } from './[id]/route';

const VIEW = '99999999-9999-4999-8999-999999999999';
const viewRow = {
  view_id: VIEW,
  account_id: 'acct-1',
  owner_user_id: 'u-me',
  name: 'Mine',
  filters: { customer_waiting: true },
  sort: null,
  shared: false,
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-01T10:00:00Z',
};
const refuse = (hint: string) => ({
  data: null,
  error: { code: 'P0001', hint },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
});

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/cases/views', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
const del = (id: string) =>
  DELETE(new Request(`http://x/api/cases/views/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/cases/views', () => {
  it('lists the caller’s views', async () => {
    m.rpc.mockResolvedValue({ data: [viewRow], error: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('case_view_list', { p_actor: 'u-me' });
    expect(await res.json()).toEqual({
      views: [
        {
          viewId: VIEW,
          ownerUserId: 'u-me',
          name: 'Mine',
          filters: { customerWaiting: true },
          sort: null,
          shared: false,
          createdAt: '2026-11-01T10:00:00.000Z',
          updatedAt: '2026-11-01T10:00:00.000Z',
        },
      ],
    });
  });

  it('is 401 when signed out', async () => {
    m.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await GET()).status).toBe(401);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/cases/views', () => {
  it('saves with SQL filter keys and answers { view }', async () => {
    m.rpc.mockResolvedValue({ data: viewRow, error: null });
    const res = await post({
      viewId: VIEW,
      name: 'Mine',
      filters: { customerWaiting: true },
      shared: false,
    });
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('case_view_save', {
      p_actor: 'u-me',
      p_view_id: VIEW,
      p_name: 'Mine',
      p_filters: { customer_waiting: true },
      p_sort: null,
      p_shared: false,
    });
    expect((await res.json()).view).toMatchObject({ viewId: VIEW });
  });

  it.each([
    ['NAME_INVALID', 422],
    ['FILTER_INVALID', 422],
    ['NOT_ALLOWED', 403],
    // another person's private view (185: no existence oracle)
    ['VIEW_NOT_FOUND', 404],
  ])('maps %s to %i', async (hint, status) => {
    m.rpc.mockResolvedValue(refuse(hint));
    const res = await post({ viewId: VIEW, name: 'x', filters: {} });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: hint });
  });

  it('refuses before any call: sort inside filters, a bad value, a non-uuid view id, a non-boolean shared', async () => {
    let res = await post({ name: 'x', filters: { sort: 'stalest' } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'FILTER_INVALID' });
    res = await post({ name: 'x', filters: { snoozed: 'never' } });
    expect(res.status).toBe(422);
    res = await post({ viewId: 'v1', name: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'VIEW_NOT_FOUND' });
    expect((await post({ name: 'x', shared: 'yes' })).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/cases/views/[id]', () => {
  it('deletes for the caller', async () => {
    m.rpc.mockResolvedValue({ data: null, error: null });
    const res = await del(VIEW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(m.rpc).toHaveBeenCalledWith('case_view_delete', {
      p_actor: 'u-me',
      p_view_id: VIEW,
    });
  });

  it('is 404 for another person’s private view and for a non-uuid id; 403 NOT_ALLOWED', async () => {
    m.rpc.mockResolvedValue(refuse('VIEW_NOT_FOUND'));
    expect((await del(VIEW)).status).toBe(404);
    m.rpc.mockResolvedValue(refuse('NOT_ALLOWED'));
    expect((await del(VIEW)).status).toBe(403);
    m.rpc.mockClear();
    expect((await del('nope')).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
