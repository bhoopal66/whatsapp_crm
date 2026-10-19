import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  dashboard: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({ list: m.list }),
  bankDashboard: () => ({ get: m.dashboard }),
}));

import { BankDashboardRefusedError } from '@/lib/cases/dashboard';

import { GET } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const get = () =>
  GET(new Request('http://x'), { params: Promise.resolve({ id: WS }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.dashboard.mockResolvedValue({ scope: 'own', totalCases: 3 });
});

describe('GET dashboard', () => {
  it("answers the workspace's dashboard for the caller", async () => {
    expect(await (await get()).json()).toEqual({
      dashboard: { scope: 'own', totalCases: 3 },
    });
    expect(m.dashboard).toHaveBeenCalledWith('u-1', WS);
  });

  it("answers 404 for a workspace not in the active account's list", async () => {
    m.list.mockResolvedValue([]);
    expect((await get()).status).toBe(404);
    expect(m.dashboard).not.toHaveBeenCalled();
  });

  it('maps a dashboard refusal', async () => {
    m.dashboard.mockRejectedValue(new BankDashboardRefusedError('NOT_ALLOWED'));
    expect((await get()).status).toBe(403);
  });
});
