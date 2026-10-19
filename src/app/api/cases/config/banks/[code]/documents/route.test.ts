import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  bankConfig: vi.fn(),
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
  caseToolsStore: () => ({
    bankConfig: m.bankConfig,
    upsertDocRequirement: m.upsert,
    deleteDocRequirement: m.del,
  }),
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

const D = {
  product: 'Personal loan',
  doc_key: 'salary_cert',
  label: 'Salary certificate',
};

beforeEach(() => {
  setup();
  m.bankConfig.mockResolvedValue({
    templates: [],
    requirements: [{ docKey: 'd' }],
  });
  m.upsert.mockResolvedValue({ docKey: 'salary_cert' });
  m.del.mockResolvedValue(false);
});

describe('documents', () => {
  it("lists every product's requirements to an agent", async () => {
    as('agent');
    expect(await (await get()).json()).toEqual({
      requirements: [{ docKey: 'd' }],
    });
    expect(m.bankConfig).toHaveBeenCalledWith('acct-1', 'ADCB');
  });

  it('answers 403 to a viewer on GET and to an agent on writes', async () => {
    as('viewer');
    expect((await get()).status).toBe(403);
    as('agent');
    expect((await post(D)).status).toBe(403);
    expect((await del('product=x&key=a')).status).toBe(403);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  it('answers 404 for a bad path code or an unknown bank', async () => {
    expect((await get('A')).status).toBe(404);
    expect((await get('ENBD')).status).toBe(404);
    expect((await post(D, 'a b')).status).toBe(404);
  });

  it('upserts as the caller in the active account', async () => {
    const res = await post({
      ...D,
      label: ' Salary certificate ',
      position: 3,
    });
    expect(await res.json()).toEqual({
      requirement: { docKey: 'salary_cert' },
    });
    expect(m.upsert).toHaveBeenCalledWith('u-1', {
      accountId: 'acct-1',
      bankCode: 'ADCB',
      product: 'Personal loan',
      docKey: 'salary_cert',
      label: 'Salary certificate',
      position: 3,
    });
  });

  it('answers 400 for bad fields', async () => {
    for (const body of [
      { ...D, product: ' ' },
      { ...D, product: 'x'.repeat(201) },
      { ...D, doc_key: 'Salary' },
      { ...D, label: '' },
      { ...D, label: 'x'.repeat(201) },
      { ...D, position: -2 },
    ])
      expect((await post(body)).status).toBe(400);
    expect((await del('key=a')).status).toBe(400);
    expect((await del('product=x&key=A')).status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  it('deletes by product and key', async () => {
    const res = await del('product=Personal%20loan&key=salary_cert');
    expect(await res.json()).toEqual({ deleted: false });
    expect(m.del).toHaveBeenCalledWith(
      'u-1',
      'acct-1',
      'ADCB',
      'Personal loan',
      'salary_cert'
    );
  });

  it('maps a hint-less CHECK violation to 422 INVALID', async () => {
    m.upsert.mockRejectedValueOnce(
      new CaseStoreError('case_doc_requirement_upsert', '23514')
    );
    const res = await post(D);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID');
    m.del.mockRejectedValueOnce(new CaseRefusedError('NOT_ALLOWED'));
    expect((await del('product=x&key=a')).status).toBe(403);
  });
});
