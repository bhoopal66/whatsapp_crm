import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  cases: vi.fn(),
  statuses: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({ list: m.list, cases: m.cases }),
}));
vi.mock('@/lib/cases/submission-status', () => ({
  submissionStatuses: m.statuses,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({}),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';

import { GET } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const get = (id = WS) =>
  GET(new Request('http://x'), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS, bankCode: 'ADCB' }]);
  m.cases.mockResolvedValue([{ caseId: 'c-1' }, { caseId: 'c-2' }]);
  m.statuses.mockResolvedValue(new Map([['c-1', 'DOCUMENTS_PENDING']]));
});

describe('GET /api/banks/[id]', () => {
  it('answers the workspace and its cases', async () => {
    const res = await get();
    expect(await res.json()).toEqual({
      workspace: { bankWsId: WS, bankCode: 'ADCB' },
      cases: [
        { caseId: 'c-1', submissionStatus: 'DOCUMENTS_PENDING' },
        { caseId: 'c-2', submissionStatus: null },
      ],
    });
    expect(m.statuses).toHaveBeenCalledWith(expect.anything(), 'acct-1', [
      'c-1',
      'c-2',
    ]);
    expect(m.list).toHaveBeenCalledWith('u-1', 'acct-1');
    expect(m.cases).toHaveBeenCalledWith(WS, 'u-1');
  });

  it("answers 404 for a workspace not in the active account's list", async () => {
    m.list.mockResolvedValue([]);
    expect((await get()).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    expect(m.cases).not.toHaveBeenCalled();
  });

  it('maps a refusal', async () => {
    m.cases.mockRejectedValue(new BankWorkspaceRefusedError('NOT_ALLOWED'));
    expect((await get()).status).toBe(403);
  });
});
