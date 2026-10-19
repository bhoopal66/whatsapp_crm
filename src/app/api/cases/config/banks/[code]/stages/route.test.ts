import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  stagesFor: vi.fn(),
  setStages: vi.fn(),
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
  caseStore: () => ({ stagesFor: m.stagesFor, setStages: m.setStages }),
}));

import { CaseRefusedError, CaseStoreError } from '@/lib/cases/store';

import { GET, PUT } from './route';

const DEFAULTS = ['Submitted', 'Approved', 'Rejected'];
let db: FakeClient;
let own: unknown[];
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: db.client };
};
const params = (code = 'ADCB') => ({ params: Promise.resolve({ code }) });
const get = (code?: string) => GET(new Request('http://x'), params(code));
const put = (body: unknown, code?: string) =>
  PUT(
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    params(code)
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  own = [];
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
      case_bank_stages: () => ({ data: own }),
    }
  );
  as('admin');
  m.stagesFor.mockResolvedValue(DEFAULTS);
  m.setStages.mockResolvedValue(3);
});

describe('GET stages', () => {
  it('answers the defaults for a bank with no list of its own', async () => {
    as('agent');
    const res = await get();
    expect(await res.json()).toEqual({ stages: DEFAULTS, isDefault: true });
    expect(m.stagesFor).toHaveBeenCalledWith('acct-1', 'ADCB');
  });

  it("answers the bank's own list", async () => {
    own = [{ position: 1 }];
    expect((await (await get()).json()).isDefault).toBe(false);
  });

  it('answers 403 to a viewer', async () => {
    as('viewer');
    expect((await get()).status).toBe(403);
  });

  it('answers 404 for a bad path code or a bank not in the account', async () => {
    expect((await get('adcb')).status).toBe(404);
    expect((await get('ENBD')).status).toBe(404);
  });
});

describe('PUT stages', () => {
  it('stores the trimmed list as the caller in the active account', async () => {
    const res = await put({ stages: [' Submitted ', 'Approved', 'Rejected'] });
    expect(await res.json()).toEqual({ count: 3 });
    expect(m.setStages).toHaveBeenCalledWith('u-1', 'acct-1', 'ADCB', [
      'Submitted',
      'Approved',
      'Rejected',
    ]);
  });

  it('passes an empty list through (back to the defaults)', async () => {
    m.setStages.mockResolvedValue(0);
    expect(await (await put({ stages: [] })).json()).toEqual({ count: 0 });
    expect(m.setStages).toHaveBeenCalledWith('u-1', 'acct-1', 'ADCB', []);
  });

  it('answers 403 to an agent', async () => {
    as('agent');
    expect((await put({ stages: ['A'] })).status).toBe(403);
    expect(m.setStages).not.toHaveBeenCalled();
  });

  it('answers 404 for a bad path code', async () => {
    expect((await put({ stages: ['A'] }, 'AD-CB')).status).toBe(404);
  });

  it('answers 400 for a bad list', async () => {
    for (const stages of [
      'Submitted',
      undefined,
      [''],
      [' '],
      [1],
      ['x'.repeat(101)],
      Array.from({ length: 51 }, (_, i) => `S${i}`),
    ])
      expect((await put({ stages })).status).toBe(400);
    expect(m.setStages).not.toHaveBeenCalled();
    expect(
      (await put({ stages: Array.from({ length: 50 }, (_, i) => `S${i}`) }))
        .status
    ).toBe(200);
  });

  it.each([
    ['STAGE_IN_USE'],
    ['BANK_STAGES_MISSING_FINAL'],
    ['BANK_STAGES_FIRST_FINAL'],
    ['BANK_STAGES_FINAL_SPELLING'],
    ['BANK_UNKNOWN'],
  ] as const)('maps %s to 422', async (code) => {
    m.setStages.mockRejectedValue(new CaseRefusedError(code));
    const res = await put({ stages: ['A'] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe(code);
  });

  it('maps a repeated stage (23505) and a CHECK violation (23514) to 422', async () => {
    m.setStages.mockRejectedValueOnce(
      new CaseStoreError('case_bank_stages_set', '23505')
    );
    let res = await put({ stages: ['A', 'A'] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('STAGE_DUPLICATE');
    m.setStages.mockRejectedValueOnce(
      new CaseStoreError('case_bank_stages_set', '23514')
    );
    res = await put({ stages: ['A'] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID');
    m.setStages.mockRejectedValueOnce(
      new CaseStoreError('case_bank_stages_set', 'XX000')
    );
    expect((await put({ stages: ['A'] })).status).toBe(500);
  });
});
