import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  threads: vi.fn(),
  posts: vi.fn(),
  retractPost: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({
    list: m.list,
    threads: m.threads,
    posts: m.posts,
    retractPost: m.retractPost,
  }),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';

import { POST } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222221';
const T2 = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const OTHER_P = '33333333-3333-4333-8333-333333333334';
const retract = (postId = P) =>
  POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ id: WS, postId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.threads.mockResolvedValue([{ threadId: T1 }, { threadId: T2 }]);
  m.posts.mockImplementation(async (t: string) =>
    t === T2 ? [{ postId: P }] : [{ postId: 'p-other' }]
  );
  m.retractPost.mockResolvedValue(undefined);
});

describe('retract', () => {
  it("retracts a post found in one of the workspace's threads", async () => {
    const res = await retract();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.threads).toHaveBeenCalledWith(WS, 'u-1');
    expect(m.retractPost).toHaveBeenCalledWith(P, 'u-1');
  });

  it('answers 404 for a post of another thread / workspace, even when the store would act', async () => {
    expect((await retract(OTHER_P)).status).toBe(404);
    m.threads.mockResolvedValue([{ threadId: T1 }]);
    expect((await retract()).status).toBe(404);
    expect(m.retractPost).not.toHaveBeenCalled();
  });

  it("answers 404 for a workspace not in the active account's list", async () => {
    m.list.mockResolvedValue([]);
    expect((await retract()).status).toBe(404);
    expect(m.retractPost).not.toHaveBeenCalled();
  });

  it("maps refusals: someone else's post 403, already retracted 422", async () => {
    m.retractPost.mockRejectedValue(
      new BankWorkspaceRefusedError('NOT_ALLOWED')
    );
    expect((await retract()).status).toBe(403);
    m.retractPost.mockRejectedValue(
      new BankWorkspaceRefusedError('ALREADY_RETRACTED')
    );
    const res = await retract();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('ALREADY_RETRACTED');
  });
});
