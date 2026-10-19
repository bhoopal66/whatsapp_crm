import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  actions: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({ list: m.list, actions: m.actions }),
}));

import { GET } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const get = () =>
  GET(new Request('http://x'), { params: Promise.resolve({ id: WS }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.actions.mockResolvedValue([{ actionId: 'a-1' }]);
});

describe('GET actions', () => {
  it("lists the workspace's actions", async () => {
    expect(await (await get()).json()).toEqual({
      actions: [{ actionId: 'a-1' }],
    });
    expect(m.list).toHaveBeenCalledWith('u-1', 'acct-1');
    expect(m.actions).toHaveBeenCalledWith(WS, 'u-1');
  });

  it("answers 404 for a workspace not in the active account's list", async () => {
    m.list.mockResolvedValue([]);
    expect((await get()).status).toBe(404);
    expect(m.actions).not.toHaveBeenCalled();
  });
});
