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

const post = (body: unknown, id = ID) => POST(req(`${id}/stage`, body), p(id));

describe('POST /api/cases/[id]/stage', () => {
  it('is 404 for another account (no role call) and for no role', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await post({ stage: 'Approved' })).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue(aCase());
    m.store.role.mockResolvedValue(null);
    expect((await post({ stage: 'Approved' })).status).toBe(404);
    expect(m.store.setStage).not.toHaveBeenCalled();
  });

  it('moves with the account-wired store and passes the group end through', async () => {
    const result = {
      moved: true,
      fromStage: 'Bank review',
      toStage: 'Approved',
      outcome: 'Approved',
      groupEnd: {
        groupEnded: true,
        reason: 'ENDED',
        end: {
          ended: true,
          reason: 'MANUAL',
          closed: false,
          closeError: null,
          closeDeferred: true,
        },
      },
    };
    m.store.setStage.mockResolvedValue(result);
    const res = await post({ stage: 'Approved', outcome: 'Approved' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(m.storeAccount).toEqual(['acct-1']);
    expect(m.store.setStage).toHaveBeenCalledWith(
      ID,
      'u-me',
      'Approved',
      'Approved'
    );
  });

  it('is 400 without a stage', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ stage: 'X', outcome: 5 })).status).toBe(400);
  });

  it.each([
    ['STAGE_NOT_CONFIGURED', 422],
    ['OUTCOME_STAGE_MISMATCH', 422],
    ['CASE_CLOSED', 422],
    ['NOT_ALLOWED', 403],
    ['CASE_NOT_FOUND', 404],
  ] as const)('maps %s to %i', async (code, status) => {
    m.store.setStage.mockRejectedValue(new CaseRefusedError(code));
    const res = await post({ stage: 'Docs' });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
  });
});
