import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  upsertBank: vi.fn(),
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
  caseStore: () => ({ upsertBank: m.upsertBank }),
}));

import { CaseRefusedError, CaseStoreError } from '@/lib/cases/store';

import { GET, POST } from './route';

let db: FakeClient;
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: db.client };
};
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = new FakeClient(
    'rls',
    [],
    {},
    {
      case_banks: () => ({
        data: [
          { code: 'ADCB', name: 'ADCB' },
          { code: 'ENBD', name: 'Emirates NBD' },
        ],
      }),
      case_bank_stages: () => ({ data: [{ bank_code: 'ENBD' }] }),
    }
  );
  as('admin');
  m.upsertBank.mockResolvedValue({
    accountId: 'acct-1',
    code: 'ADCB',
    name: 'ADCB Bank',
  });
});

describe('GET banks', () => {
  it("lists the active account's banks and which have their own list", async () => {
    as('agent');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      banks: [
        { code: 'ADCB', name: 'ADCB', hasOwnStages: false },
        { code: 'ENBD', name: 'Emirates NBD', hasOwnStages: true },
      ],
    });
    for (const q of db.queries)
      expect(q.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('answers 403 to a viewer and a bank guest', async () => {
    as('viewer');
    expect((await GET()).status).toBe(403);
    as('bank_guest');
    expect((await GET()).status).toBe(403);
    expect(db.queries).toHaveLength(0);
  });

  it('answers 500 when the read fails', async () => {
    db.tables.case_banks = () => ({ error: { code: '42P01' } });
    expect((await GET()).status).toBe(500);
  });
});

describe('POST banks', () => {
  it('creates or renames the bank as the caller in the active account', async () => {
    const res = await post({ code: 'ADCB', name: '  ADCB Bank ' });
    expect(res.status).toBe(200);
    expect((await res.json()).bank.name).toBe('ADCB Bank');
    expect(m.upsertBank).toHaveBeenCalledWith(
      'u-1',
      'acct-1',
      'ADCB',
      'ADCB Bank'
    );
  });

  it('answers 403 to an agent', async () => {
    as('agent');
    expect((await post({ code: 'ADCB', name: 'x' })).status).toBe(403);
    expect(m.upsertBank).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad code or name', async () => {
    for (const body of [
      { code: 'adcb', name: 'x' },
      { code: 'A', name: 'x' },
      { code: 'A'.repeat(33), name: 'x' },
      { code: 'ADCB', name: ' ' },
      { code: 'ADCB', name: 'x'.repeat(101) },
      { code: 'ADCB' },
    ])
      expect((await post(body)).status).toBe(400);
    expect(m.upsertBank).not.toHaveBeenCalled();
  });

  it('maps refusals and a hint-less CHECK violation to 422', async () => {
    m.upsertBank.mockRejectedValueOnce(new CaseRefusedError('NOT_ALLOWED'));
    expect((await post({ code: 'ADCB', name: 'x' })).status).toBe(403);
    m.upsertBank.mockRejectedValueOnce(
      new CaseStoreError('case_bank_upsert', '23514')
    );
    const res = await post({ code: 'ADCB', name: 'x' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID');
  });
});
