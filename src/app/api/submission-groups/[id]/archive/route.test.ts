import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  viewArchive: vi.fn(),
  service: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => ({ get: mocks.get }),
  submissionGroupService: mocks.service,
}));

import { UnauthorizedError } from '@/lib/auth/account';

import { POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const post = () =>
  POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ id: G }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAccount.mockResolvedValue({
    userId: 'lead-1',
    accountId: 'acct-1',
    role: 'team_leader',
  });
  mocks.get.mockResolvedValue({ id: G, accountId: 'acct-1' });
  mocks.service.mockReturnValue({ viewArchive: mocks.viewArchive });
  mocks.viewArchive.mockResolvedValue({
    allowed: true,
    messages: [{ id: '1', body: 'hello' }],
  });
});

describe('POST archive', () => {
  it('answers the archive when the service allows it', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([{ id: '1', body: 'hello' }]);
    expect(mocks.service).toHaveBeenCalledWith('acct-1');
    expect(mocks.viewArchive).toHaveBeenCalledWith({
      groupId: G,
      userId: 'lead-1',
    });
  });

  it('answers 403 when the service refuses', async () => {
    mocks.viewArchive.mockResolvedValue({ allowed: false });
    expect((await post()).status).toBe(403);
  });

  it("answers 404 for another account's group and reads nothing", async () => {
    mocks.get.mockResolvedValue({ id: G, accountId: 'acct-2' });
    expect((await post()).status).toBe(404);
    expect(mocks.viewArchive).not.toHaveBeenCalled();
  });

  it('answers 401 without a session', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
