import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  list: vi.fn(),
  threads: vi.fn(),
  markAction: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  bankWorkspaceStore: () => ({
    list: m.list,
    threads: m.threads,
    markAction: m.markAction,
  }),
}));

import { BankWorkspaceRefusedError } from '@/lib/cases/bank-workspaces';
import { CaseRefusedError } from '@/lib/cases/store';

import { POST } from './route';

const WS = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const OTHER_T = '22222222-2222-4222-8222-222222222223';
const OWNER = '55555555-5555-4555-8555-555555555555';
const DUE = '2026-10-20T09:00:00.000Z';
const post = (body: unknown, threadId = T) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: WS, threadId }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.list.mockResolvedValue([{ bankWsId: WS }]);
  m.threads.mockResolvedValue([{ threadId: T }]);
  m.markAction.mockResolvedValue('a-1');
});

describe('mark action', () => {
  it('marks the thread and answers 201', async () => {
    const res = await post({ owner_id: OWNER, due_at: DUE });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ actionId: 'a-1' });
    expect(m.markAction).toHaveBeenCalledWith({
      threadId: T,
      actor: 'u-1',
      ownerId: OWNER,
      dueAt: new Date(DUE),
    });
  });

  it('passes a missing due date as null (the SQL answers DUE_REQUIRED)', async () => {
    m.markAction.mockRejectedValue(
      new BankWorkspaceRefusedError('DUE_REQUIRED')
    );
    const res = await post({ owner_id: OWNER });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('DUE_REQUIRED');
    expect(m.markAction.mock.calls[0][0].dueAt).toBeNull();
  });

  it('answers 404 for a thread of another workspace', async () => {
    expect((await post({ owner_id: OWNER, due_at: DUE }, OTHER_T)).status).toBe(
      404
    );
    m.list.mockResolvedValue([]);
    expect((await post({ owner_id: OWNER, due_at: DUE })).status).toBe(404);
    expect(m.markAction).not.toHaveBeenCalled();
  });

  it('answers 400 for a non-uuid owner or a non-string due date', async () => {
    expect((await post({ owner_id: 'bob', due_at: DUE })).status).toBe(400);
    expect((await post({ owner_id: OWNER, due_at: 5 })).status).toBe(400);
    expect(m.markAction).not.toHaveBeenCalled();
  });

  it('maps a case refusal raised underneath', async () => {
    m.markAction.mockRejectedValue(new CaseRefusedError('CASE_CLOSED'));
    const res = await post({ owner_id: OWNER, due_at: DUE });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CASE_CLOSED');
  });
});
