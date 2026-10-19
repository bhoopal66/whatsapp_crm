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
import { GET } from './route';

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

const get = (qs = '', id = ID) => GET(req(`${id}/audit${qs}`), p(id));

describe('GET /api/cases/[id]/audit', () => {
  it('is 404 for another account and for no role', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await get()).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue(aCase());
    m.store.role.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it.each(['coordinator', 'team_lead', 'agent'])(
    'is 403 for a %s',
    async (role) => {
      m.store.role.mockResolvedValue(role);
      expect((await get()).status).toBe(403);
      expect(m.store.auditList).not.toHaveBeenCalled();
    }
  );

  it('lists for an admin and a super_admin, limit default 100', async () => {
    const row = {
      id: 'a1',
      caseId: ID,
      viewerId: U,
      viewerRole: 'coordinator',
      viewedAt: new Date('2026-10-18T10:00:00Z'),
    };
    m.store.auditList.mockResolvedValue([row]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [{ ...row, viewedAt: '2026-10-18T10:00:00.000Z' }],
    });
    expect(m.store.auditList).toHaveBeenCalledWith('u-me', ID, 100);
    m.store.role.mockResolvedValue('super_admin');
    expect((await get('?limit=20')).status).toBe(200);
    expect(m.store.auditList).toHaveBeenLastCalledWith('u-me', ID, 20);
  });

  it('is 400 for a non-numeric limit, 422 for one the database refuses', async () => {
    expect((await get('?limit=all')).status).toBe(400);
    m.store.auditList.mockRejectedValue(new CaseRefusedError('LIMIT_INVALID'));
    expect((await get('?limit=99999')).status).toBe(422);
  });
});
