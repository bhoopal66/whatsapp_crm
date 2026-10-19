import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  listTasks: vi.fn(),
  setTaskStatus: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  caseToolsStore: () => ({
    listTasks: m.listTasks,
    setTaskStatus: m.setTaskStatus,
  }),
}));

import { CaseRefusedError } from '@/lib/cases/store';

import { PATCH } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const T = '44444444-4444-4444-8444-444444444444';
const patch = (body: unknown, taskId = T) =>
  PATCH(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: C, taskId }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
  m.role.mockResolvedValue('coordinator');
  m.listTasks.mockResolvedValue([{ id: T }]);
  m.setTaskStatus.mockResolvedValue({
    changed: true,
    fromStatus: 'open',
    toStatus: 'done',
  });
});

describe('PATCH task', () => {
  it('sets the status as the caller', async () => {
    const res = await patch({ status: 'done' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: true,
      fromStatus: 'open',
      toStatus: 'done',
    });
    expect(m.listTasks).toHaveBeenCalledWith(C);
    expect(m.setTaskStatus).toHaveBeenCalledWith(T, 'u-1', 'done');
  });

  it('answers 404 for a task of another case, or a non-uuid task id', async () => {
    m.listTasks.mockResolvedValue([
      { id: '55555555-5555-4555-8555-555555555555' },
    ]);
    expect((await patch({ status: 'done' })).status).toBe(404);
    expect((await patch({ status: 'done' }, 'nope')).status).toBe(404);
    expect(m.setTaskStatus).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's case and role null", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await patch({ status: 'done' })).status).toBe(404);
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
    m.role.mockResolvedValue(null);
    expect((await patch({ status: 'done' })).status).toBe(404);
    expect(m.setTaskStatus).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad status', async () => {
    expect((await patch({ status: 'closed' })).status).toBe(400);
    expect(m.setTaskStatus).not.toHaveBeenCalled();
  });

  it('maps TASK_NOT_FOUND to 404 and other refusals to 422', async () => {
    m.setTaskStatus.mockRejectedValue(new CaseRefusedError('TASK_NOT_FOUND'));
    expect((await patch({ status: 'done' })).status).toBe(404);
    m.setTaskStatus.mockRejectedValue(new CaseRefusedError('STATUS_INVALID'));
    const res = await patch({ status: 'done' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('STATUS_INVALID');
  });
});
