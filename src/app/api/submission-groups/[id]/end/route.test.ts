import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  get: vi.fn(),
  endNow: vi.fn(),
  service: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => ({ get: mocks.get }),
  submissionGroupService: mocks.service,
}));

import { ForbiddenError } from '@/lib/auth/account';

import { POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const post = () =>
  POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ id: G }),
  });
const result = {
  ended: true,
  reason: 'MANUAL',
  closed: true,
  closeError: null,
  closeDeferred: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    userId: 'admin-1',
    accountId: 'acct-1',
    role: 'admin',
  });
  mocks.get.mockResolvedValue({ id: G, accountId: 'acct-1' });
  mocks.service.mockReturnValue({ endNow: mocks.endNow });
  mocks.endNow.mockResolvedValue(result);
});

describe('POST end', () => {
  it('ends the group manually and answers the result', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.service).toHaveBeenCalledWith('acct-1');
    expect(mocks.endNow).toHaveBeenCalledWith(G, 'MANUAL');
  });

  it("answers 404 for another account's group and ends nothing", async () => {
    mocks.get.mockResolvedValue({ id: G, accountId: 'acct-2' });
    expect((await post()).status).toBe(404);
    expect(mocks.endNow).not.toHaveBeenCalled();
  });

  it('answers 403 below admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError());
    expect((await post()).status).toBe(403);
    expect(mocks.endNow).not.toHaveBeenCalled();
  });
});
