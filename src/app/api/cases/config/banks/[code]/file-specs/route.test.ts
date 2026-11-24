import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  bankConfig: vi.fn(),
  admin: null as unknown,
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
  caseToolsStore: () => ({ bankConfig: m.bankConfig }),
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => m.admin,
}));

import { GET, PUT } from './route';

let rls: FakeClient;
let admin: FakeClient;
let specRows: Record<string, unknown>[];
let setResult: { data?: unknown; error?: unknown };
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: rls.client };
};
const params = (code = 'ADCB') => ({ params: Promise.resolve({ code }) });
const get = (query = 'product=Personal%20loan', code?: string) =>
  GET(new Request(`http://x/?${query}`), params(code));
const put = (body: unknown, code?: string) =>
  PUT(
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    params(code)
  );

const ROW = {
  docKey: 'passport',
  position: 1,
  namePattern: '{{company}}_{{doc}}',
  required: true,
  maxMb: 10,
  allowedMime: ['application/pdf'],
  minValidDays: 30,
  merged: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  specRows = [];
  setResult = { data: 'audit-1' };
  rls = new FakeClient(
    'rls',
    [],
    {},
    {
      case_banks: (q) => ({
        data: q.filters.some(([, k, v]) => k === 'code' && v === 'ADCB')
          ? [{ code: 'ADCB', name: 'ADCB' }]
          : [],
      }),
      case_file_specs: () => ({ data: specRows }),
    }
  );
  admin = new FakeClient('admin', [], {
    case_file_spec_set: () => setResult as never,
  });
  m.admin = admin.client;
  m.bankConfig.mockResolvedValue({
    templates: [],
    requirements: [
      { product: 'Personal loan', docKey: 'passport', label: 'Passport' },
      { product: ' PERSONAL LOAN ', docKey: 'salary', label: 'Salary' },
      { product: 'Mortgage', docKey: 'title', label: 'Title deed' },
    ],
  });
  as('admin');
});

describe('GET file specs', () => {
  it('answers defaults to an agent when no spec is stored', async () => {
    as('agent');
    const res = await get();
    expect(await res.json()).toEqual({
      product: 'Personal loan',
      requirements: [
        { docKey: 'passport', label: 'Passport' },
        { docKey: 'salary', label: 'Salary' },
      ],
      rows: [],
      usesDefaults: true,
    });
    expect(m.bankConfig).toHaveBeenCalledWith('acct-1', 'ADCB');
    expect(rls.queriesOf('case_file_specs')[0]!.filters).toEqual([
      ['eq', 'account_id', 'acct-1'],
      ['eq', 'bank_code', 'ADCB'],
    ]);
  });

  it("answers the product's stored rows, matched case-insensitively", async () => {
    specRows = [
      {
        product: 'personal loan ',
        doc_key: 'passport',
        position: 1,
        name_pattern: '{{company}}_{{doc}}',
        required: true,
        max_mb: 10,
        allowed_mime: ['application/pdf'],
        min_valid_days: 30,
        merged: true,
      },
      {
        product: 'Mortgage',
        doc_key: 'title',
        position: 1,
        name_pattern: 'x',
        required: true,
        max_mb: 5,
        allowed_mime: ['image/png'],
        min_valid_days: null,
        merged: false,
      },
    ];
    const json = await (await get()).json();
    expect(json.rows).toEqual([ROW]);
    expect(json.usesDefaults).toBe(false);
  });

  it('answers 403 to a viewer, 404 for a bad or unknown bank, 400 without a product', async () => {
    as('viewer');
    expect((await get()).status).toBe(403);
    as('agent');
    expect((await get(undefined, 'a b')).status).toBe(404);
    expect((await get(undefined, 'ENBD')).status).toBe(404);
    expect((await get('product=%20')).status).toBe(400);
    expect(m.bankConfig).not.toHaveBeenCalled();
  });
});

describe('PUT file specs', () => {
  it("passes the loaded rows on as the database's, every key present", async () => {
    const res = await put({
      product: 'Personal loan',
      rows: [ROW],
      expected: [{ ...ROW, minValidDays: undefined }],
    });
    expect(res.status).toBe(200);
    expect(admin.rpcs[0].args).toMatchObject({
      p_expected: [
        {
          doc_key: ROW.docKey,
          position: ROW.position,
          name_pattern: ROW.namePattern,
          required: ROW.required,
          max_mb: ROW.maxMb,
          allowed_mime: ROW.allowedMime,
          min_valid_days: null,
          merged: ROW.merged,
        },
      ],
    });
  });

  it('answers 409 SPEC_CHANGED', async () => {
    setResult = { error: { code: '23514', hint: 'SPEC_CHANGED' } };
    const res = await put({ product: 'P', rows: [ROW], expected: [] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SPEC_CHANGED');
    expect(admin.rpcs[0].args).toMatchObject({ p_expected: [] });
  });

  it('refuses an expected that is not a list of rows', async () => {
    for (const expected of ['x', [1], null]) {
      const res = await put({ product: 'P', rows: [ROW], expected });
      expect(res.status).toBe(422);
    }
    expect(admin.rpcs).toEqual([]);
  });

  it('replaces the spec as the caller and answers the audit id', async () => {
    const res = await put({
      product: ' Personal loan ',
      rows: [
        ROW,
        {
          ...ROW,
          docKey: 'salary',
          position: 2,
          namePattern: null,
          minValidDays: undefined,
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auditId: 'audit-1' });
    expect(admin.rpcs).toEqual([
      {
        fn: 'case_file_spec_set',
        args: {
          p_actor: 'u-1',
          p_bank_code: 'ADCB',
          p_product: 'Personal loan',
          p_rows: [
            {
              doc_key: 'passport',
              name_pattern: '{{company}}_{{doc}}',
              position: 1,
              required: true,
              max_mb: 10,
              allowed_mime: ['application/pdf'],
              min_valid_days: 30,
              merged: true,
            },
            {
              doc_key: 'salary',
              name_pattern: '{{case}}_{{doc}}_{{yyyymmdd}}',
              position: 2,
              required: true,
              max_mb: 10,
              allowed_mime: ['application/pdf'],
              min_valid_days: null,
              merged: true,
            },
          ],
        },
      },
    ]);
  });

  it('passes an empty list through (it removes the spec)', async () => {
    expect((await put({ product: 'Personal loan', rows: [] })).status).toBe(
      200
    );
    expect(admin.rpcs[0]!.args.p_rows).toEqual([]);
  });

  it('is admin-only', async () => {
    as('agent');
    expect((await put({ product: 'Personal loan', rows: [ROW] })).status).toBe(
      403
    );
    expect(admin.rpcs).toEqual([]);
  });

  it('answers 404 for a bad path code and 400 for a bad product', async () => {
    expect((await put({ product: 'x', rows: [] }, 'a b')).status).toBe(404);
    expect((await put({ product: ' ', rows: [] })).status).toBe(400);
    expect((await put({ product: 'x'.repeat(201), rows: [] })).status).toBe(
      400
    );
    expect(admin.rpcs).toEqual([]);
  });

  it('answers 422 for a non-integer position without calling SQL', async () => {
    for (const position of [1.5, '1', null, 0])
      expect(
        (await put({ product: 'Personal loan', rows: [{ ...ROW, position }] }))
          .status
      ).toBe(422);
    const res = await put({
      product: 'Personal loan',
      rows: [{ ...ROW, position: 2.5 }],
    });
    expect(await res.json()).toEqual({
      error: 'That file spec is not valid',
      code: 'SPEC_INVALID',
    });
    expect(admin.rpcs).toEqual([]);
  });

  it('answers 422 SPEC_INVALID for every other malformed row, without calling SQL', async () => {
    const bad: unknown[] = [
      undefined,
      'rows',
      [null],
      [{ ...ROW, allowedMime: ['image/gif'] }],
      [{ ...ROW, allowedMime: [] }],
      [{ ...ROW, allowedMime: 'application/pdf' }],
      [{ ...ROW, maxMb: 0 }],
      [{ ...ROW, maxMb: 101 }],
      [{ ...ROW, maxMb: 2.5 }],
      [ROW, { ...ROW, position: 2 }],
      [ROW, { ...ROW, docKey: 'salary' }],
      [ROW, { ...ROW, docKey: 'salary', position: 2, merged: false }],
      [{ ...ROW, docKey: 'Passport' }],
      [{ ...ROW, required: 'yes' }],
      [{ ...ROW, merged: undefined }],
      [{ ...ROW, minValidDays: -1 }],
      [{ ...ROW, minValidDays: 3651 }],
      [{ ...ROW, namePattern: ' ' }],
      [{ ...ROW, namePattern: '{{bank}}_{{doc}}' }],
      [{ ...ROW, namePattern: 'x'.repeat(201) }],
      [{ ...ROW, extra: 1 }],
    ];
    for (const rows of bad) {
      const res = await put({ product: 'Personal loan', rows });
      expect(res.status, JSON.stringify(rows)).toBe(422);
      expect((await res.json()).code).toBe('SPEC_INVALID');
    }
    expect(admin.rpcs).toEqual([]);
  });

  it('maps the SQL refusals', async () => {
    const cases: [string, number][] = [
      ['DOCS_INVALID', 422],
      ['BANK_UNKNOWN', 422],
      ['SPEC_INVALID', 422],
      ['NOT_ALLOWED', 403],
    ];
    for (const [hint, status] of cases) {
      setResult = { error: { hint, code: '23514' } };
      const res = await put({ product: 'Personal loan', rows: [ROW] });
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(hint);
    }
    setResult = { error: { code: '22P02' } };
    expect((await put({ product: 'Personal loan', rows: [ROW] })).status).toBe(
      500
    );
  });
});
