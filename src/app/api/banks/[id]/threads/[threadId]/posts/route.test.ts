import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  threads: vi.fn(),
  posts: vi.fn(),
  addPost: vi.fn(),
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
    addPost: m.addPost,
  }),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';

import { GET, POST } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const OTHER_T = '22222222-2222-4222-8222-222222222223';
const PARENT = '33333333-3333-4333-8333-333333333333';
const params = (threadId = T) => ({
  params: Promise.resolve({ id: WS, threadId }),
});
const post = (body: unknown, threadId = T) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params(threadId)
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.threads.mockResolvedValue([{ threadId: T }]);
  m.posts.mockResolvedValue([{ postId: PARENT }]);
  m.addPost.mockResolvedValue('p-2');
});

describe('posts', () => {
  it("lists the thread's posts", async () => {
    const res = await GET(new Request('http://x'), params());
    expect(await res.json()).toEqual({ posts: [{ postId: PARENT }] });
    expect(m.threads).toHaveBeenCalledWith(WS, 'u-1');
    expect(m.posts).toHaveBeenCalledWith(T, 'u-1');
  });

  it('adds a trimmed reply and answers 201', async () => {
    const res = await post({ body: ' ok ', parent_post_id: PARENT });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ postId: 'p-2' });
    expect(m.addPost).toHaveBeenCalledWith({
      threadId: T,
      actor: 'u-1',
      parentPostId: PARENT,
      body: 'ok',
      caseId: null,
      taskId: null,
    });
  });

  it('answers 404 for a thread of another workspace', async () => {
    expect((await post({ body: 'b' }, OTHER_T)).status).toBe(404);
    expect((await GET(new Request('http://x'), params(OTHER_T))).status).toBe(
      404
    );
    expect(m.addPost).not.toHaveBeenCalled();
    expect(m.posts).not.toHaveBeenCalled();
  });

  it("answers 404 for a workspace not in the active account's list", async () => {
    m.list.mockResolvedValue([]);
    expect((await post({ body: 'b' })).status).toBe(404);
    expect(m.addPost).not.toHaveBeenCalled();
  });

  it('answers 400 over the cap or with a bad parent', async () => {
    expect((await post({ body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await post({ body: 'b', parent_post_id: 7 })).status).toBe(400);
    expect(m.addPost).not.toHaveBeenCalled();
  });

  it('maps a refusal to 422 with its code', async () => {
    m.addPost.mockRejectedValue(
      new BankWorkspaceRefusedError('PARENT_INVALID')
    );
    const res = await post({ body: 'b' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('PARENT_INVALID');
  });
});
