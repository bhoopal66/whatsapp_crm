import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  banks: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({ list: m.list, create: m.create }),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';

import { GET, POST } from './route';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '11111111-1111-4111-8111-111111111112';

/** ctx.supabase.from('case_banks').select().eq().order() */
function rlsClient() {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => m.banks()),
  };
  m.from.mockReturnValue(chain);
  return { from: m.from, chain };
}

function as(role: string) {
  const supabase = rlsClient();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    supabase,
  });
  return supabase;
}

const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  as('admin');
  m.list.mockResolvedValue([{ bankWsId: WS_A, bankCode: 'ADCB' }]);
  m.banks.mockResolvedValue({
    data: [
      { code: 'ADCB', name: 'ADCB' },
      { code: 'ENBD', name: 'Emirates NBD' },
    ],
    error: null,
  });
  m.create.mockResolvedValue(WS_B);
});

describe('GET /api/banks', () => {
  it("lists the active account's workspaces and, for an admin, the banks without one", async () => {
    const { chain } = as('admin');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaces: [{ bankWsId: WS_A, bankCode: 'ADCB' }],
      creatable: [{ code: 'ENBD', name: 'Emirates NBD' }],
    });
    expect(m.list).toHaveBeenCalledWith('u-1', 'acct-1');
    expect(m.from).toHaveBeenCalledWith('case_banks');
    expect(chain.eq).toHaveBeenCalledWith('account_id', 'acct-1');
  });

  it('gives an agent no creatable banks and does not read them', async () => {
    as('agent');
    expect(await (await GET()).json()).toEqual({
      workspaces: [{ bankWsId: WS_A, bankCode: 'ADCB' }],
      creatable: [],
    });
    expect(m.from).not.toHaveBeenCalled();
  });

  it('answers 500 when the bank list cannot be read', async () => {
    m.banks.mockResolvedValue({ data: null, error: { code: '42501' } });
    expect((await GET()).status).toBe(500);
  });
});

describe('POST /api/banks', () => {
  it('creates the workspace for the active account and answers 201', async () => {
    const res = await post({ bank_code: 'ENBD' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: WS_B });
    expect(m.create).toHaveBeenCalledWith('u-1', 'acct-1', 'ENBD');
  });

  it('answers 200 when the bank already had a workspace', async () => {
    m.create.mockResolvedValue(WS_A);
    const res = await post({ bank_code: 'ADCB' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: WS_A });
  });

  it('refuses an agent with 403 before any call', async () => {
    as('agent');
    expect((await post({ bank_code: 'ENBD' })).status).toBe(403);
    as('team_leader');
    expect((await post({ bank_code: 'ENBD' })).status).toBe(403);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('answers 400 without a bank_code', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ bank_code: '  ' })).status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('maps an unknown bank to 422 with its code', async () => {
    m.create.mockRejectedValue(new BankWorkspaceRefusedError('BANK_UNKNOWN'));
    const res = await post({ bank_code: 'NOPE' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('BANK_UNKNOWN');
  });
});
