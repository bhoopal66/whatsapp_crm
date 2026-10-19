import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  memory: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({ caseStore: () => m.store }));
vi.mock('@/lib/memory/server', () => ({ memoryStore: () => m.memory }));

import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const as = (role: string) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role,
  });

beforeEach(() => {
  vi.clearAllMocks();
  as('admin');
  m.store = {
    get: vi.fn(async () => ({ id: ID, accountId: 'acct-1' })),
    role: vi.fn(async () => 'admin'),
  };
  m.memory = { forget: vi.fn(async () => 3) };
});

const post = (body: unknown, id = ID) =>
  POST(
    new Request(`http://x/api/cases/${id}/memory/forget`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

describe('POST /api/cases/[id]/memory/forget', () => {
  it('is 404 for another account (no role call) and for no role', async () => {
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-2' });
    expect((await post({ reason: 'request' })).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-1' });
    m.store.role.mockResolvedValue(null);
    expect((await post({ reason: 'request' })).status).toBe(404);
    expect(m.memory.forget).not.toHaveBeenCalled();
  });

  it.each(['agent', 'team_leader', 'viewer'])('is 403 for %s', async (role) => {
    as(role);
    expect((await post({ reason: 'request' })).status).toBe(403);
    expect(m.memory.forget).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('erases the case scope for %s', async (role) => {
    as(role);
    const res = await post({ reason: 'customer request' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ erased: 3 });
    expect(m.memory.forget).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      { type: 'case', id: ID },
      'customer request'
    );
  });

  it('is 400 for a missing or rejected reason', async () => {
    expect((await post({})).status).toBe(400);
    m.memory.forget.mockRejectedValue(new RangeError('blank'));
    expect((await post({ reason: '  ' })).status).toBe(400);
  });
});
