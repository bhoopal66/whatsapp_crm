import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  threads: vi.fn(),
  createThread: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({
    list: m.list,
    threads: m.threads,
    createThread: m.createThread,
  }),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';
import { CaseStoreError } from '@/lib/cases/store';

import { GET, POST } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const CASE = '44444444-4444-4444-8444-444444444444';
const params = () => ({ params: Promise.resolve({ id: WS }) });
const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params()
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.threads.mockResolvedValue([{ threadId: 't-1' }]);
  m.createThread.mockResolvedValue('t-2');
});

describe('threads', () => {
  it('lists the threads', async () => {
    const res = await GET(new Request('http://x'), params());
    expect(await res.json()).toEqual({ threads: [{ threadId: 't-1' }] });
    expect(m.threads).toHaveBeenCalledWith(WS, 'u-1');
  });

  it('creates a trimmed thread with its link and answers 201', async () => {
    const res = await post({
      title: ' Docs ',
      body: ' need X ',
      case_id: CASE,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ threadId: 't-2' });
    expect(m.createThread).toHaveBeenCalledWith({
      bankWsId: WS,
      actor: 'u-1',
      title: 'Docs',
      body: 'need X',
      caseId: CASE,
      taskId: null,
    });
  });

  it("answers 404 for a workspace not in the active account's list, even when the store would act", async () => {
    m.list.mockResolvedValue([{ bankWsId: CASE }]);
    expect((await post({ title: 't', body: 'b' })).status).toBe(404);
    expect((await GET(new Request('http://x'), params())).status).toBe(404);
    expect(m.createThread).not.toHaveBeenCalled();
    expect(m.threads).not.toHaveBeenCalled();
  });

  it('answers 400 over the caps, for a blank text or a bad link', async () => {
    expect((await post({ title: 'x'.repeat(201), body: 'b' })).status).toBe(
      400
    );
    expect((await post({ title: 't', body: 'x'.repeat(4001) })).status).toBe(
      400
    );
    expect((await post({ title: ' ', body: 'b' })).status).toBe(400);
    expect((await post({ title: 't', body: 'b', task_id: 'x' })).status).toBe(
      400
    );
    expect(m.createThread).not.toHaveBeenCalled();
    expect(
      (await post({ title: 'x'.repeat(200), body: 'x'.repeat(4000) })).status
    ).toBe(201);
  });

  it('maps refusals to 422 / 403 and never logs the text', async () => {
    m.createThread.mockRejectedValue(
      new BankWorkspaceRefusedError('LINK_INVALID')
    );
    const res = await post({ title: 't', body: 'secret text' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('LINK_INVALID');
    m.createThread.mockRejectedValue(
      new BankWorkspaceRefusedError('NOT_ALLOWED')
    );
    expect((await post({ title: 't', body: 'b' })).status).toBe(403);
    m.createThread.mockRejectedValue(
      new CaseStoreError('bank_ws_thread_create', '23514')
    );
    expect((await post({ title: 't', body: 'secret text' })).status).toBe(500);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'secret'
    );
  });
});
