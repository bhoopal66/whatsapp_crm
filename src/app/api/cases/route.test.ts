import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  groupGet: vi.fn(),
  rpcResult: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
  requireRole: m.requireRole,
}));
// The inbox's rpc answers m.rpcResult.
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: async () => m.rpcResult }),
  submissionGroupStore: () => ({ get: m.groupGet }),
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ open: m.open }),
}));
// The real inbox (its filter check is the one validator) over a fake rpc.
vi.mock('@/lib/cases/inbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cases/inbox')>();
  class CaseInbox extends real.CaseInbox {
    override list(
      ...args: Parameters<InstanceType<typeof real.CaseInbox>['list']>
    ) {
      m.list(...args);
      return super.list(...args);
    }
  }
  return { ...real, CaseInbox };
});

import { ForbiddenError } from '@/lib/auth/account';
import { GET, POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';
const ctx = { userId: 'u-me', accountId: 'acct-1', role: 'admin' };

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue(ctx);
  m.requireRole.mockResolvedValue(ctx);
  m.rpcResult = { data: [], error: null };
});

const get = (qs: string) => GET(new Request(`http://x/api/cases?${qs}`));
const post = (body: unknown) =>
  POST(
    new Request('http://x/api/cases', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

describe('GET /api/cases', () => {
  it('lists for the caller and the active account with parsed filters', async () => {
    m.rpcResult = {
      data: [
        {
          case_id: 'c1',
          stage: 'New',
          agent_id: A,
          priority: 'high',
          overdue_rank: [5, 1],
          last_activity_at: '2026-10-18T10:00:00Z',
          opened_at: '2026-10-01T10:00:00Z',
        },
      ],
      error: null,
    };
    const res = await get(
      `bank=ADCB&customer_waiting=true&no_activity_days=3&limit=10&unknown=1`
    );
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      { bank: 'ADCB', customerWaiting: true, noActivityDays: 3 },
      { limit: 10, after: undefined }
    );
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.rows[0]).toMatchObject({
      caseId: 'c1',
      agentId: A,
      overdueRank: { slaOverdueMinutes: 5, overdueTasks: 1 },
    });
  });

  it.each([
    ['customer_waiting=yes', 'FILTER_INVALID'],
    ['no_activity_days=0', 'FILTER_INVALID'],
    ['sort=random', 'FILTER_INVALID'],
    ['limit=ten', 'LIMIT_INVALID'],
    ['after=notjson', 'CURSOR_INVALID'],
  ])('refuses %s with 422 %s', async (qs, code) => {
    const res = await get(qs);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code });
  });

  it('maps a database refusal', async () => {
    m.rpcResult = { data: null, error: { hint: 'NOT_ALLOWED', code: 'P0001' } };
    expect((await get('')).status).toBe(403);
  });
});

describe('POST /api/cases', () => {
  it('refuses a non-admin with 403', async () => {
    m.requireRole.mockRejectedValue(new ForbiddenError());
    expect((await post({ group_id: G })).status).toBe(403);
    expect(m.open).not.toHaveBeenCalled();
  });

  it('is 404 for a group of another account', async () => {
    m.groupGet.mockResolvedValue({ id: G, accountId: 'acct-2' });
    expect((await post({ group_id: G })).status).toBe(404);
    expect(m.open).not.toHaveBeenCalled();
  });

  it('is 400 for a bad body', async () => {
    expect((await post({ group_id: 'x' })).status).toBe(400);
    expect((await post({ group_id: G, amount: '-5' })).status).toBe(400);
    expect((await post({ group_id: G, bank: 7 })).status).toBe(400);
  });

  it('opens: 201 when created, 200 when it existed', async () => {
    m.groupGet.mockResolvedValue({ id: G, accountId: 'acct-1' });
    m.open.mockResolvedValue({ caseId: 'c1', created: true });
    const res = await post({
      group_id: G,
      bank: 'ADCB',
      product: 'Mortgage',
      amount: 1500,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ caseId: 'c1', created: true });
    expect(m.requireRole).toHaveBeenCalledWith('admin');
    expect(m.open).toHaveBeenCalledWith(
      G,
      { bankCode: 'ADCB', product: 'Mortgage', amount: '1500' },
      'u-me'
    );
    m.open.mockResolvedValue({ caseId: 'c1', created: false });
    expect((await post({ group_id: G })).status).toBe(200);
  });

  it('maps a refusal from case_open to 422', async () => {
    m.groupGet.mockResolvedValue({ id: G, accountId: 'acct-1' });
    const { CaseRefusedError } = await import('@/lib/cases/store');
    m.open.mockRejectedValue(new CaseRefusedError('NO_AGENT'));
    const res = await post({ group_id: G });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'NO_AGENT' });
  });
});
