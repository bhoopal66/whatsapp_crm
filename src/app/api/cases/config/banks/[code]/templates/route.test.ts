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
    upsertTaskTemplate: m.upsert,
    deleteTaskTemplate: m.del,
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

const T = { template_key: 'call_bank', title: 'Call the bank' };

beforeEach(() => {
  setup();
  m.bankConfig.mockResolvedValue({
    templates: [{ templateKey: 't' }],
    requirements: [],
  });
  m.upsert.mockResolvedValue({ templateKey: 'call_bank' });
  m.del.mockResolvedValue(true);
});

describe('templates', () => {
  it("lists the bank's templates to an agent", async () => {
    as('agent');
    expect(await (await get()).json()).toEqual({
      templates: [{ templateKey: 't' }],
    });
    expect(m.bankConfig).toHaveBeenCalledWith('acct-1', 'ADCB');
  });

  it('answers 403 to a viewer on GET and to an agent on writes', async () => {
    as('viewer');
    expect((await get()).status).toBe(403);
    as('agent');
    expect((await post(T)).status).toBe(403);
    expect((await del('key=call_bank')).status).toBe(403);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  it('answers 404 for a bad path code or an unknown bank', async () => {
    expect((await get('Adcb')).status).toBe(404);
    expect((await get('ENBD')).status).toBe(404);
    expect((await post(T, 'x')).status).toBe(404);
    expect((await del('key=a', 'x')).status).toBe(404);
  });

  it('upserts as the caller in the active account', async () => {
    const res = await post({
      ...T,
      title: ' Call the bank ',
      position: 2,
      due_hours: 48,
    });
    expect(await res.json()).toEqual({
      template: { templateKey: 'call_bank' },
    });
    expect(m.upsert).toHaveBeenCalledWith('u-1', {
      accountId: 'acct-1',
      bankCode: 'ADCB',
      templateKey: 'call_bank',
      title: 'Call the bank',
      position: 2,
      dueHours: 48,
    });
    await post(T);
    expect(m.upsert).toHaveBeenLastCalledWith(
      'u-1',
      expect.objectContaining({ position: null, dueHours: null })
    );
  });

  it('answers 400 for bad fields', async () => {
    for (const body of [
      { ...T, template_key: 'Call_bank' },
      { ...T, template_key: 'call-bank' },
      { ...T, template_key: 'x'.repeat(65) },
      { ...T, title: '' },
      { ...T, title: 'x'.repeat(201) },
      { ...T, position: 0 },
      { ...T, position: 1.5 },
      { ...T, position: '2' },
      { ...T, due_hours: -1 },
    ])
      expect((await post(body)).status).toBe(400);
    expect((await del('key=Bad')).status).toBe(400);
    expect((await del('')).status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  it('deletes by key', async () => {
    expect(await (await del('key=call_bank')).json()).toEqual({
      deleted: true,
    });
    expect(m.del).toHaveBeenCalledWith('u-1', 'acct-1', 'ADCB', 'call_bank');
  });

  it("refuses to delete the bank spaces' Action needed template", async () => {
    expect((await del('key=bank_ws_action_needed')).status).toBe(400);
    expect(m.del).not.toHaveBeenCalled();
  });

  it('maps refusals and CHECK violations to 422', async () => {
    m.upsert.mockRejectedValueOnce(new CaseRefusedError('BANK_UNKNOWN'));
    let res = await post(T);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('BANK_UNKNOWN');
    m.upsert.mockRejectedValueOnce(
      new CaseStoreError('case_task_template_upsert', '23514')
    );
    res = await post(T);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID');
  });
});
