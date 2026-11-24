import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
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
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => m.admin,
}));

import { POST as approve } from './[kind]/approve/route';
import { PUT } from './[kind]/route';
import { GET } from './route';

let rls: FakeClient;
let admin: FakeClient;
let setResult: { data?: unknown; error?: unknown };
let approveResult: { data?: unknown; error?: unknown };
let rows: Record<string, unknown>[];
let stored: Record<string, unknown>[];

const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: rls.client };
};
const params = (kind: string) => ({ params: Promise.resolve({ kind }) });
const put = (kind: string, body: unknown) =>
  PUT(
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    params(kind)
  );
const post = (kind: string, body?: unknown) =>
  approve(
    new Request('http://x', {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params(kind)
  );

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rows = [];
  stored = [];
  setResult = { data: false };
  approveResult = { data: true };
  rls = new FakeClient(
    'rls',
    [],
    {},
    { case_intake_templates: () => ({ data: rows }) }
  );
  admin = new FakeClient(
    'admin',
    [],
    {
      case_intake_template_set: () => setResult as never,
      case_intake_template_approve: () => approveResult as never,
    },
    { case_intake_templates: () => ({ data: stored }) }
  );
  m.admin = admin.client;
  as('admin');
});

describe('GET intake templates', () => {
  it('fills the kinds that were never written', async () => {
    as('agent');
    rows = [
      {
        kind: 'document_rejected',
        body: 'Please resend',
        approved: true,
        approved_by: 'u-2',
        approved_at: '2026-11-01T00:00:00Z',
        updated_by: 'u-3',
        updated_at: '2026-10-31T00:00:00Z',
      },
    ];
    const res = await GET();
    expect(res.status).toBe(200);
    const { templates } = await res.json();
    expect(templates.map((t: { kind: string }) => t.kind)).toEqual([
      'document_classify',
      'document_rejected',
      'document_received_next',
    ]);
    expect(templates[0]).toEqual({
      kind: 'document_classify',
      body: null,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      updatedBy: null,
      updatedAt: null,
    });
    expect(templates[1]).toMatchObject({
      body: 'Please resend',
      approved: true,
      approvedBy: 'u-2',
      updatedBy: 'u-3',
    });
    expect(rls.queries[0].filters).toContainEqual([
      'eq',
      'account_id',
      'acct-1',
    ]);
  });

  it('is refused below agent', async () => {
    as('viewer');
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT intake template', () => {
  it('saves for the active account and answers the stored flag', async () => {
    const res = await put('document_classify', { body: 'Which document?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: false });
    expect(admin.rpcs).toEqual([
      {
        fn: 'case_intake_template_set',
        args: {
          p_actor: 'u-1',
          p_account: 'acct-1',
          p_kind: 'document_classify',
          p_body: 'Which document?',
        },
      },
    ]);
  });

  it('refuses a wording saved over one the screen never showed', async () => {
    const at = '2026-11-24T10:00:00.123456+00:00';
    stored = [{ updated_at: at }];
    const stale = await put('document_classify', {
      body: 'Mine',
      updatedAt: '2026-11-23T10:00:00+00:00',
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('TEMPLATE_CHANGED');
    const none = await put('document_classify', {
      body: 'Mine',
      updatedAt: null,
    });
    expect(none.status).toBe(409);
    expect(admin.rpcs).toHaveLength(0);
    const ok = await put('document_classify', { body: 'Mine', updatedAt: at });
    expect(ok.status).toBe(200);
    stored = [];
    const first = await put('document_classify', {
      body: 'Mine',
      updatedAt: null,
    });
    expect(first.status).toBe(200);
  });

  it('refuses an agent', async () => {
    as('agent');
    expect((await put('document_classify', { body: 'x' })).status).toBe(403);
    expect(admin.rpcs).toHaveLength(0);
  });

  it('404s an unknown kind without an RPC', async () => {
    expect((await put('nope', { body: 'x' })).status).toBe(404);
    expect(admin.rpcs).toHaveLength(0);
  });

  it.each([
    ['missing', {}],
    ['not a string', { body: 5 }],
    ['blank', { body: ' \t\n ' }],
    ['too long', { body: 'a'.repeat(1001) }],
  ])('422s a %s body without an RPC', async (_n, body) => {
    const res = await put('document_classify', body);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('TEMPLATE_INVALID');
    expect(admin.rpcs).toHaveLength(0);
  });

  it('accepts exactly 1000 characters', async () => {
    expect(
      (await put('document_classify', { body: 'a'.repeat(1000) })).status
    ).toBe(200);
  });

  it('maps the SQL refusals', async () => {
    setResult = { error: { code: '42501', hint: 'NOT_ALLOWED' } };
    expect((await put('document_classify', { body: 'x' })).status).toBe(403);
    setResult = { error: { code: '23514', hint: 'TEMPLATE_INVALID' } };
    expect((await put('document_classify', { body: 'x' })).status).toBe(422);
    setResult = { error: { code: 'XX000' } };
    const res = await put('document_classify', { body: 'x' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
  });
});

describe('POST approve intake template', () => {
  it('approves as the owner', async () => {
    as('owner');
    const res = await post('document_rejected');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: true });
    expect(admin.rpcs[0]).toEqual({
      fn: 'case_intake_template_approve',
      args: {
        p_actor: 'u-1',
        p_account: 'acct-1',
        p_kind: 'document_rejected',
      },
    });
  });

  it('refuses an admin', async () => {
    as('admin');
    expect((await post('document_rejected')).status).toBe(403);
    expect(admin.rpcs).toHaveLength(0);
  });

  it('404s an unknown kind', async () => {
    as('owner');
    expect((await post('nope')).status).toBe(404);
    expect(admin.rpcs).toHaveLength(0);
  });

  it('approves the wording the owner was shown and answers its row', async () => {
    as('owner');
    const updatedAt = '2026-11-24T10:00:00.123456+00:00';
    approveResult = {
      data: {
        kind: 'document_rejected',
        body: 'Text',
        approved: true,
        updated_at: '2026-11-24T10:05:00.5+00:00',
      },
    };
    const res = await post('document_rejected', { updatedAt });
    expect(await res.json()).toEqual({
      kind: 'document_rejected',
      body: 'Text',
      approved: true,
      updatedAt: '2026-11-24T10:05:00.5+00:00',
    });
    expect(admin.rpcs[0].args).toMatchObject({
      p_expected_updated_at: updatedAt,
    });
  });

  it('answers 409 TEMPLATE_CHANGED', async () => {
    as('owner');
    approveResult = { error: { code: '23514', hint: 'TEMPLATE_CHANGED' } };
    const res = await post('document_rejected', {
      updatedAt: '2026-11-24T10:00:00Z',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('TEMPLATE_CHANGED');
  });

  it('400s a version that is no date', async () => {
    as('owner');
    for (const updatedAt of ['yesterday', 5, '2026-99-99T00:00:00Z'])
      expect((await post('document_rejected', { updatedAt })).status).toBe(400);
    expect(admin.rpcs).toHaveLength(0);
  });

  it('answers 409 SELF_APPROVAL', async () => {
    as('owner');
    approveResult = { error: { code: '42501', hint: 'SELF_APPROVAL' } };
    const res = await post('document_rejected');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SELF_APPROVAL');
  });
});
