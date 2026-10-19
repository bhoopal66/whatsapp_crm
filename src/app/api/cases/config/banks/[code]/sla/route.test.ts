import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  listConfig: vi.fn(),
  stagesFor: vi.fn(),
  upsert: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    requireRole: async (min: Parameters<typeof real.requireRole>[0]) => {
      if (!hasMinRole(m.ctx.role as typeof min, min))
        throw new real.ForbiddenError('Insufficient role');
      return m.ctx;
    },
  };
});
vi.mock('@/lib/cases/server', () => ({
  caseSlaStore: () => ({
    listConfig: m.listConfig,
    upsertConfig: m.upsert,
    deleteConfig: m.del,
  }),
  caseStore: () => ({ stagesFor: m.stagesFor }),
}));

import { CaseRefusedError, CaseStoreError } from '@/lib/cases/store';

import { DELETE, GET, POST } from './route';

let db: FakeClient;
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: db.client };
};
const params = (code = 'ADCB') => ({ params: Promise.resolve({ code }) });
const get = (code?: string) => GET(new Request('http://x'), params(code));
const post = (body: unknown, code?: string) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params(code)
  );
const del = (query: string, code?: string) =>
  DELETE(new Request(`http://x/?${query}`, { method: 'DELETE' }), params(code));

function setup() {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = new FakeClient(
    'rls',
    [],
    {},
    {
      case_banks: (q) => ({
        data: q.filters.some(([, k, v]) => k === 'code' && v === 'ADCB')
          ? [{ code: 'ADCB', name: 'ADCB' }]
          : [],
      }),
    }
  );
  as('admin');
}

const S = {
  stage: 'Submitted',
  timer: 'bank_response',
  amount: 2,
  unit: 'days',
};

beforeEach(() => {
  setup();
  m.listConfig.mockResolvedValue([{ stage: 'Submitted' }]);
  m.stagesFor.mockResolvedValue(['Submitted', 'Approved']);
  m.upsert.mockResolvedValue({ stage: 'Submitted' });
  m.del.mockResolvedValue(true);
});

describe('sla', () => {
  it("answers the bank's config and stages to an agent", async () => {
    as('agent');
    expect(await (await get()).json()).toEqual({
      config: [{ stage: 'Submitted' }],
      stages: ['Submitted', 'Approved'],
    });
    expect(m.listConfig).toHaveBeenCalledWith('acct-1', 'ADCB');
    expect(m.stagesFor).toHaveBeenCalledWith('acct-1', 'ADCB');
  });

  it('answers 403 to a viewer on GET and to an agent on writes', async () => {
    as('viewer');
    expect((await get()).status).toBe(403);
    as('agent');
    expect((await post(S)).status).toBe(403);
    expect((await del('stage=Submitted&timer=bank_response')).status).toBe(403);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  it('answers 404 for a bad path code or an unknown bank', async () => {
    expect((await get('adcb')).status).toBe(404);
    expect((await get('ENBD')).status).toBe(404);
    expect((await post(S, 'x')).status).toBe(404);
  });

  it('upserts as the caller in the active account', async () => {
    const res = await post({ ...S, due_soon_pct: 25, due_soon_minutes: 90 });
    expect(await res.json()).toEqual({ config: { stage: 'Submitted' } });
    expect(m.upsert).toHaveBeenCalledWith('u-1', {
      accountId: 'acct-1',
      bankCode: 'ADCB',
      stage: 'Submitted',
      timer: 'bank_response',
      amount: 2,
      unit: 'days',
      dueSoonPct: 25,
      dueSoonMinutes: 90,
    });
    await post(S);
    expect(m.upsert).toHaveBeenLastCalledWith(
      'u-1',
      expect.objectContaining({ dueSoonPct: undefined, dueSoonMinutes: null })
    );
  });

  it('answers 400 for bad fields', async () => {
    for (const body of [
      { ...S, stage: '' },
      { ...S, timer: 'other' },
      { ...S, unit: 'hours' },
      { ...S, amount: 0 },
      { ...S, amount: '2' },
      { ...S, due_soon_pct: 100 },
      { ...S, due_soon_minutes: 0 },
    ])
      expect((await post(body)).status).toBe(400);
    expect((await del('stage=Submitted&timer=x')).status).toBe(400);
    expect((await del('timer=bank_response')).status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  it('deletes by stage and timer', async () => {
    const res = await del('stage=Submitted&timer=bank_response');
    expect(await res.json()).toEqual({ deleted: true });
    expect(m.del).toHaveBeenCalledWith(
      'u-1',
      'acct-1',
      'ADCB',
      'Submitted',
      'bank_response'
    );
  });

  it('maps refusals and a hint-less CHECK violation to 422', async () => {
    m.upsert.mockRejectedValueOnce(
      new CaseRefusedError('STAGE_NOT_CONFIGURED')
    );
    let res = await post(S);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('STAGE_NOT_CONFIGURED');
    m.upsert.mockRejectedValueOnce(
      new CaseStoreError('case_sla_config_upsert', '23514')
    );
    res = await post(S);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID');
  });
});
