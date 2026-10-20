import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  summary: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({ list: m.list, summary: m.summary }),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';

import { GET } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const SUMMARY = {
  openCases: 2,
  members: { agents: 1, coordinators: 1, teamLeads: 0, total: 2 },
  openActions: 1,
  myRole: 'agent',
};
const get = () =>
  GET(new Request('http://x'), { params: Promise.resolve({ id: WS }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.summary.mockResolvedValue(SUMMARY);
});

describe('GET summary', () => {
  it("answers the workspace's summary for the caller, uncached", async () => {
    const res = await get();
    expect(await res.json()).toEqual({ summary: SUMMARY });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(m.list).toHaveBeenCalledWith('u-1', 'acct-1');
    expect(m.summary).toHaveBeenCalledWith(WS, 'u-1');
  });

  it("answers 404 for a workspace not in the active account's list", async () => {
    m.list.mockResolvedValue([]);
    expect((await get()).status).toBe(404);
    expect(m.summary).not.toHaveBeenCalled();
  });

  it('answers the same 404 when the SQL gives NULL (no access)', async () => {
    m.summary.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Bank workspace not found' });
  });

  it('maps a refusal', async () => {
    m.summary.mockRejectedValue(new BankWorkspaceRefusedError('NOT_ALLOWED'));
    expect((await get()).status).toBe(403);
  });
});
