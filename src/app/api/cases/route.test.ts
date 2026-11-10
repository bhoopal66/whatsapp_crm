import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  groupGet: vi.fn(),
  rpcResult: { data: null, error: null } as { data: unknown; error: unknown },
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  statuses: vi.fn(),
  names: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
  requireRole: m.requireRole,
}));
// The inbox's rpc answers m.rpcResult.
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => (
      m.rpcCalls.push({ fn, args }),
      m.rpcResult
    ),
  }),
  submissionGroupStore: () => ({ get: m.groupGet }),
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ open: m.open }),
}));
vi.mock('@/lib/cases/submission-status', () => ({
  submissionStatuses: m.statuses,
}));
vi.mock('@/lib/cases/contact-names', () => ({
  contactNames: m.names,
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
  m.rpcCalls.length = 0;
  m.getCurrentAccount.mockResolvedValue(ctx);
  m.requireRole.mockResolvedValue(ctx);
  m.rpcResult = { data: [], error: null };
  m.statuses.mockResolvedValue(new Map());
  m.names.mockResolvedValue(new Map());
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
    m.statuses.mockResolvedValue(new Map([['c1', 'UNDER_REVIEW']]));
    m.names.mockResolvedValue(new Map([['k1', 'Nasrullah']]));
    m.rpcResult = {
      data: [
        {
          case_id: 'c1',
          contact_id: 'k1',
          contact_name: 'ALA DIN GENTS SALOON L.L.C',
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
      submissionStatus: 'UNDER_REVIEW',
      contactName: 'ALA DIN GENTS SALOON L.L.C',
      contactOwnName: 'Nasrullah',
    });
    expect(m.statuses).toHaveBeenCalledWith(expect.anything(), 'acct-1', [
      'c1',
    ]);
    expect(m.names).toHaveBeenCalledWith(expect.anything(), 'acct-1', ['k1']);
  });

  it.each([
    ['customer_waiting=yes', 'FILTER_INVALID'],
    ['no_activity_days=0', 'FILTER_INVALID'],
    ['sort=random', 'FILTER_INVALID'],
    ['limit=ten', 'LIMIT_INVALID'],
    ['after=notjson', 'CURSOR_INVALID'],
    ['snoozed=later', 'FILTER_INVALID'],
    ['mentionedMe=yes', 'FILTER_INVALID'],
  ])('refuses %s with 422 %s', async (qs, code) => {
    const res = await get(qs);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code });
  });

  it('without 185’s params sends exactly the filters it did before', async () => {
    await get('bank=ADCB&sort=stalest');
    expect(Object.keys(m.rpcCalls[0].args).sort()).toEqual([
      'p_account',
      'p_actor',
      'p_after',
      'p_filters',
      'p_limit',
      'p_now',
    ]);
    expect(m.rpcCalls[0].args).toMatchObject({
      p_actor: 'u-me',
      p_account: 'acct-1',
      p_filters: { bank: 'ADCB', sort: 'stalest' },
      p_limit: 50,
      p_after: null,
    });
  });

  it('maps snoozed / snoozeExpired / mentionedMe onto 185’s filter keys', async () => {
    await get('snoozed=only&snoozeExpired=true&mentionedMe=false');
    expect(m.list).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      { snoozed: 'only', snoozeExpired: true, mentionedMe: false },
      { limit: undefined, after: undefined }
    );
    expect(m.rpcCalls[0].args.p_filters).toEqual({
      snoozed: 'only',
      snooze_expired: true,
      mentioned_me: false,
    });
  });

  it('rows carry snoozedUntil and snoozeExpired', async () => {
    m.rpcResult = {
      data: [
        {
          case_id: 'c1',
          stage: 'New',
          agent_id: A,
          last_activity_at: '2026-10-18T10:00:00Z',
          opened_at: '2026-10-01T10:00:00Z',
          snoozed_until: '2026-10-20T10:00:00Z',
          snooze_expired: false,
        },
      ],
      error: null,
    };
    const body = await (await get('snoozed=all')).json();
    expect(body.rows[0]).toMatchObject({
      snoozedUntil: '2026-10-20T10:00:00.000Z',
      snoozeExpired: false,
    });
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
