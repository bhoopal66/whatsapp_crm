import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  storeAccount: [] as unknown[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: (accountId?: string) => (m.storeAccount.push(accountId), m.store),
}));

import { CaseRefusedError } from '@/lib/cases/store';
import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const U = '44444444-4444-4444-8444-444444444444';
const aCase = (over: Record<string, unknown> = {}) => ({
  id: ID,
  accountId: 'acct-1',
  stage: 'New',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.storeAccount.length = 0;
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
  m.store = {
    get: vi.fn(async () => aCase()),
    role: vi.fn(async () => 'admin'),
    setStage: vi.fn(),
    reassign: vi.fn(),
    auditList: vi.fn(async () => []),
  };
});

const p = (id = ID) => ({ params: Promise.resolve({ id }) });
const req = (path: string, body?: unknown) =>
  new Request(`http://x/api/cases/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const post = (body: unknown, id = ID) =>
  POST(req(`${id}/reassign`, body), p(id));

describe('POST /api/cases/[id]/reassign', () => {
  it('is 404 for another account and for no role', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await post({ field: 'agent', user_id: U })).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue(aCase());
    m.store.role.mockResolvedValue(null);
    expect((await post({ field: 'agent', user_id: U })).status).toBe(404);
  });

  it.each(['coordinator', 'agent'])('is 403 for a %s', async (role) => {
    m.store.role.mockResolvedValue(role);
    expect((await post({ field: 'agent', user_id: U })).status).toBe(403);
    expect(m.store.reassign).not.toHaveBeenCalled();
  });

  it('reassigns for a team lead', async () => {
    m.store.role.mockResolvedValue('team_lead');
    m.store.reassign.mockResolvedValue({
      changed: true,
      fromUser: null,
      toUser: U,
    });
    const res = await post({ field: 'coordinator', user_id: U });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: true,
      fromUser: null,
      toUser: U,
    });
    expect(m.store.reassign).toHaveBeenCalledWith(ID, 'u-me', 'coordinator', U);
  });

  it('is 400 for a bad body, 422 for a refused assignee', async () => {
    expect((await post({ field: 'owner', user_id: U })).status).toBe(400);
    expect((await post({ field: 'agent', user_id: 'x' })).status).toBe(400);
    m.store.reassign.mockRejectedValue(
      new CaseRefusedError('ASSIGNEE_INVALID')
    );
    const res = await post({ field: 'agent', user_id: U });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'ASSIGNEE_INVALID' });
  });
});
