import { beforeEach, describe, expect, it, vi } from 'vitest';

// 022b: `after` runs nothing in a unit test; the brain sink is stubbed.
const brain = vi.hoisted(() => ({
  record: vi.fn(async () => {}),
  after: [] as (() => unknown)[],
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => unknown) => {
    brain.after.push(cb);
  },
}));
vi.mock('@/lib/brain/sink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/brain/sink')>()),
  brainSink: () => ({ record: brain.record }),
}));

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  cases: {} as Record<string, ReturnType<typeof vi.fn>>,
  deps: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => m.cases,
  caseMacroDeps: () => m.deps,
}));

import { CaseRefusedError } from '@/lib/cases/store';
import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const aCase = (over: Record<string, unknown> = {}) => ({
  id: ID,
  accountId: 'acct-1',
  groupId: 'g-1',
  agentId: 'u-agent',
  coordinatorId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
  });
  m.cases = {
    get: vi.fn(async () => aCase()),
    role: vi.fn(async () => 'agent'),
  };
  m.deps = {
    macros: {
      get: vi.fn(async () => ({
        id: MID,
        actions: [
          { kind: 'add_note', body: 'x' },
          { kind: 'set_stage', stage: 'Approved', outcome: 'Approved' },
        ],
      })),
      logApply: vi.fn(async () => '1'),
    },
    cases: {
      setStage: vi.fn(async () => {
        throw new CaseRefusedError('MANAGED_EXTERNALLY');
      }),
    },
    tools: { createTask: vi.fn(), docRequestBegin: vi.fn() },
    notes: { add: vi.fn(async () => ({ noteId: 'n' })) },
  };
});

const apply = (id = ID, macroId = MID) =>
  POST(new Request(`http://x/api/cases/${id}/macros/${macroId}/apply`), {
    params: Promise.resolve({ id, macroId }),
  });

const nothingWritten = () => {
  expect(m.deps.notes.add).not.toHaveBeenCalled();
  expect(m.deps.cases.setStage).not.toHaveBeenCalled();
  expect(m.deps.macros.logApply).not.toHaveBeenCalled();
};

describe('POST /api/cases/[id]/macros/[macroId]/apply', () => {
  it('another account’s case is 404 before the role or the macro is read', async () => {
    m.cases.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    const res = await apply();
    expect(res.status).toBe(404);
    expect(m.cases.role).not.toHaveBeenCalled();
    expect(m.deps.macros.get).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('an unreadable case is 404, nothing read or written', async () => {
    m.cases.role.mockResolvedValue(null);
    expect((await apply()).status).toBe(404);
    expect(m.deps.macros.get).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('an invisible macro is 404 MACRO_NOT_FOUND, nothing written or logged', async () => {
    m.deps.macros.get.mockRejectedValue(
      new CaseRefusedError('MACRO_NOT_FOUND')
    );
    const res = await apply();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('MACRO_NOT_FOUND');
    nothingWritten();
  });

  it('a refused action answers 200 with stoppedAt, earlier actions applied', async () => {
    const res = await apply();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([
      { kind: 'add_note', ok: true },
      expect.objectContaining({
        kind: 'set_stage',
        ok: false,
        code: 'MANAGED_EXTERNALLY',
      }),
    ]);
    expect(body.stoppedAt).toMatchObject({
      index: 1,
      code: 'MANAGED_EXTERNALLY',
    });
    expect(m.deps.notes.add).toHaveBeenCalledTimes(1);
    expect(m.deps.macros.logApply).toHaveBeenCalledTimes(1);
  });
});

describe('macro apply: second-brain hook', () => {
  it('records a timeline event for the stage the macro moved', async () => {
    brain.after.length = 0;
    m.deps.cases.setStage.mockResolvedValue({
      moved: true,
      fromStage: 'New',
      toStage: 'Approved',
      outcome: 'Approved',
      groupEnd: null,
    });
    expect((await apply()).status).toBe(200);
    for (const cb of brain.after) await cb();
    expect(brain.record).toHaveBeenCalledTimes(1);
    expect(brain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'timeline',
        ref: expect.objectContaining({
          accountId: 'acct-1',
          caseId: ID,
          createdBy: 'u-me',
        }),
      })
    );
  });

  it('records nothing when the stage action was refused', async () => {
    brain.after.length = 0;
    expect((await apply()).status).toBe(200);
    for (const cb of brain.after) await cb();
    expect(brain.record).not.toHaveBeenCalled();
  });

  it('records nothing when the case is not readable', async () => {
    brain.after.length = 0;
    m.cases.role.mockResolvedValue(null);
    expect((await apply()).status).toBe(404);
    for (const cb of brain.after) await cb();
    expect(brain.record).not.toHaveBeenCalled();
  });
});
