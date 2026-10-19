import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  timers: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => m.store,
  caseSlaStore: () => ({ timers: m.timers }),
}));

import { CaseRefusedError } from '@/lib/cases/store';
import { GET, PATCH } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const aCase = (over: Record<string, unknown> = {}) => ({
  id: ID,
  accountId: 'acct-1',
  bankCode: 'ADCB',
  stage: 'New',
  ...over,
});

const reason = { data: null as unknown, error: null as unknown };
const eq = vi.fn(() => ({ maybeSingle: async () => reason }));
const from = vi.fn(() => ({ select: () => ({ eq }) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
    supabase: { from },
  });
  m.store = {
    get: vi.fn(async () => aCase()),
    role: vi.fn(async () => 'coordinator'),
    stagesFor: vi.fn(async () => ['New', 'Approved']),
    history: vi.fn(async () => ({
      stages: [],
      reassignments: [],
      details: [],
    })),
    setDetails: vi.fn(async () => ['product']),
    setPriority: vi.fn(async () => true),
    setDue: vi.fn(async () => true),
  };
  m.timers.mockResolvedValue([]);
  reason.data = null;
  reason.error = null;
});

const p = (id = ID) => ({ params: Promise.resolve({ id }) });
const get = (id = ID) => GET(new Request(`http://x/api/cases/${id}`), p(id));
const patch = (body: unknown, id = ID) =>
  PATCH(
    new Request(`http://x/api/cases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    p(id)
  );

describe('GET /api/cases/[id]', () => {
  it('is 404 for a case of another account, before any role call', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    m.store.role.mockResolvedValue('super_admin');
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Case not found' });
    expect(m.store.role).not.toHaveBeenCalled();
  });

  it('is 404 when the caller has no role, and for a non-uuid id', async () => {
    m.store.role.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect((await get('abc')).status).toBe(404);
  });

  it('answers the case, role, permissions, stages, history, timers, reason', async () => {
    reason.data = {
      reason_code: 'KYC_AML',
      reason_text: null,
      created_at: '2026-10-18T10:00:00Z',
    };
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      case: aCase(),
      role: 'coordinator',
      permissions: { canWrite: true, canReassign: false, canSeeAudit: false },
      stages: ['New', 'Approved'],
      history: { stages: [], reassignments: [], details: [] },
      timers: [],
      outcomeReason: {
        reasonCode: 'KYC_AML',
        reasonText: null,
        createdAt: '2026-10-18T10:00:00Z',
      },
    });
    expect(m.store.stagesFor).toHaveBeenCalledWith('acct-1', 'ADCB');
    expect(m.timers).toHaveBeenCalledWith(ID);
    // The reason is read through the caller's RLS client.
    expect(from).toHaveBeenCalledWith('case_outcome_reasons');
    expect(eq).toHaveBeenCalledWith('case_id', ID);
  });

  it('gives an admin the audit permission', async () => {
    m.store.role.mockResolvedValue('admin');
    expect((await (await get()).json()).permissions).toEqual({
      canWrite: true,
      canReassign: true,
      canSeeAudit: true,
    });
  });
});

describe('PATCH /api/cases/[id]', () => {
  it('is 404 for another account and for no role', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await patch({ product: 'X' })).status).toBe(404);
    m.store.get.mockResolvedValue(aCase());
    m.store.role.mockResolvedValue(null);
    expect((await patch({ product: 'X' })).status).toBe(404);
    expect(m.store.setDetails).not.toHaveBeenCalled();
  });

  it('applies details, priority and due date, answering the fresh case', async () => {
    m.store.get
      .mockResolvedValueOnce(aCase())
      .mockResolvedValueOnce(aCase({ product: 'Card' }));
    const res = await patch({
      bank_code: 'FAB',
      product: 'Card',
      amount: '2500.00',
      priority: 'urgent',
      due_at: '2026-10-25T08:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ case: aCase({ product: 'Card' }) });
    expect(m.store.setDetails).toHaveBeenCalledWith(ID, 'u-me', {
      bankCode: 'FAB',
      product: 'Card',
      amount: '2500.00',
    });
    expect(m.store.setPriority).toHaveBeenCalledWith(ID, 'u-me', 'urgent');
    expect(m.store.setDue).toHaveBeenCalledWith(
      ID,
      'u-me',
      new Date('2026-10-25T08:00:00.000Z')
    );
  });

  it('clears the due date with null and leaves the rest alone', async () => {
    expect((await patch({ due_at: null })).status).toBe(200);
    expect(m.store.setDue).toHaveBeenCalledWith(ID, 'u-me', null);
    expect(m.store.setDetails).not.toHaveBeenCalled();
    expect(m.store.setPriority).not.toHaveBeenCalled();
  });

  it('is 400 for a bad or empty body', async () => {
    for (const body of [
      {},
      { due_at: 'tomorrow' },
      { amount: 'lots' },
      { product: null },
      { priority: 3 },
      [1],
    ])
      expect((await patch(body)).status).toBe(400);
  });

  it('maps a database refusal to 422 with its code', async () => {
    m.store.setPriority.mockRejectedValue(
      new CaseRefusedError('PRIORITY_INVALID')
    );
    const res = await patch({ priority: 'meh' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'PRIORITY_INVALID' });
  });
});
