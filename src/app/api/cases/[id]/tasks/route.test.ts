import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  listTasks: vi.fn(),
  bankConfig: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  caseToolsStore: () => ({
    listTasks: m.listTasks,
    bankConfig: m.bankConfig,
    createTask: m.createTask,
  }),
}));

import { CaseRefusedError } from '@/lib/cases/store';

import { GET, POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const U = '33333333-3333-4333-8333-333333333333';
const params = (id = C) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params()
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', bankCode: 'adcb' });
  m.role.mockResolvedValue('agent');
  m.listTasks.mockResolvedValue([{ id: 't1' }]);
  m.bankConfig.mockResolvedValue({
    templates: [{ templateKey: 'k' }],
    requirements: [],
  });
  m.createTask.mockResolvedValue('t2');
});

describe('GET tasks', () => {
  it("answers the case's tasks and its bank's templates", async () => {
    const res = await GET(new Request('http://x'), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tasks: [{ id: 't1' }],
      templates: [{ templateKey: 'k' }],
    });
    expect(m.listTasks).toHaveBeenCalledWith(C);
    expect(m.bankConfig).toHaveBeenCalledWith('acct-1', 'adcb');
  });

  it('answers no templates for a case with no bank', async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1', bankCode: null });
    expect(
      (await (await GET(new Request('http://x'), params())).json()).templates
    ).toEqual([]);
    expect(m.bankConfig).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's case and for no role", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2', bankCode: null });
    expect((await GET(new Request('http://x'), params())).status).toBe(404);
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1', bankCode: null });
    m.role.mockResolvedValue(null);
    expect((await GET(new Request('http://x'), params())).status).toBe(404);
    expect(m.listTasks).not.toHaveBeenCalled();
  });
});

describe('POST tasks', () => {
  it('creates the task as the caller and answers 201', async () => {
    const res = await post({
      template_key: 'call_bank',
      owner_id: U,
      due_at: '2026-11-01T10:00:00Z',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ taskId: 't2' });
    expect(m.createTask).toHaveBeenCalledWith({
      caseId: C,
      actor: 'u-1',
      templateKey: 'call_bank',
      ownerId: U,
      dueAt: new Date('2026-11-01T10:00:00Z'),
    });
  });

  it('defaults owner and due to null', async () => {
    await post({ template_key: 'call_bank' });
    expect(m.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: null, dueAt: null })
    );
  });

  it('answers 400 on a bad shape', async () => {
    for (const body of [
      null,
      { template_key: 'Bad Key' },
      { template_key: 'k', owner_id: 'x' },
      { template_key: 'k', due_at: 'soon' },
    ])
      expect((await post(body)).status).toBe(400);
    expect(m.createTask).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's case and role null", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post({ template_key: 'k' })).status).toBe(404);
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
    m.role.mockResolvedValue(null);
    expect((await post({ template_key: 'k' })).status).toBe(404);
    expect(m.createTask).not.toHaveBeenCalled();
  });

  it('maps refusals', async () => {
    m.createTask.mockRejectedValue(new CaseRefusedError('TEMPLATE_NOT_FOUND'));
    const res = await post({ template_key: 'k' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('TEMPLATE_NOT_FOUND');
    m.createTask.mockRejectedValue(new CaseRefusedError('NOT_ALLOWED'));
    expect((await post({ template_key: 'k' })).status).toBe(403);
  });
});
