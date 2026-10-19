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

import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
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

const post = (body?: unknown, id = ID) =>
  POST(req(`${id}/presence`, body ?? {}), p(id));
const as = (userId: string) =>
  m.getCurrentAccount.mockResolvedValue({ userId, accountId: 'acct-1' });

describe('POST /api/cases/[id]/presence', () => {
  it('is 404 for another account, before any role call', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await post()).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
  });

  it('is 404 and records nothing when the caller has no role', async () => {
    const C = '55555555-5555-4555-8555-555555555555';
    m.store.get.mockResolvedValue(aCase({ id: C }));
    m.store.role.mockResolvedValue(null);
    as('u-out');
    expect((await post({}, C)).status).toBe(404);
    m.store.role.mockResolvedValue('agent');
    as('u-in');
    expect(await (await post({}, C)).json()).toEqual({ viewers: [] });
  });

  it('answers the others on the case, never the caller', async () => {
    as('u-a');
    expect(await (await post()).json()).toEqual({ viewers: [] });
    as('u-b');
    expect(await (await post({ state: 'typing' })).json()).toEqual({
      viewers: ['u-a'],
    });
    as('u-a');
    expect(await (await post()).json()).toEqual({ viewers: ['u-b'] });
    expect(m.store.role).toHaveBeenCalledWith(ID, 'u-a');
  });

  it('is 400 for an unknown state', async () => {
    expect((await post({ state: 'sleeping' })).status).toBe(400);
  });
});
