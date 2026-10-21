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

import { GET, PUT } from './route';

let rls: FakeClient;
let admin: FakeClient;
let setResult: { data?: unknown; error?: unknown };
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: rls.client };
};
const put = (body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rls = new FakeClient(
    'rls',
    [],
    {},
    { case_account_settings: () => ({ data: [{ managed_externally: true }] }) }
  );
  setResult = { data: true };
  admin = new FakeClient('admin', [], {
    case_settings_set: () => setResult as never,
  });
  m.admin = admin.client;
  as('admin');
});

describe('GET case settings', () => {
  it("reads the active account's row through RLS", async () => {
    as('agent');
    const res = await GET();
    expect(await res.json()).toEqual({ settings: { managedExternally: true } });
    expect(rls.queries[0]!.filters).toContainEqual([
      'eq',
      'account_id',
      'acct-1',
    ]);
  });

  it('is off when the account never saved one', async () => {
    rls = new FakeClient('rls', [], {}, { case_account_settings: () => ({}) });
    as('agent');
    expect(await (await GET()).json()).toEqual({
      settings: { managedExternally: false },
    });
  });

  it('answers 403 to a viewer', async () => {
    as('viewer');
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT case settings', () => {
  it('sets it through case_settings_set for the caller and active account', async () => {
    const res = await put({ managed_externally: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: { managedExternally: true } });
    expect(admin.rpcs).toEqual([
      {
        fn: 'case_settings_set',
        args: {
          p_actor: 'u-1',
          p_account: 'acct-1',
          p_managed_externally: true,
        },
      },
    ]);
  });

  it('is admin-only and needs a boolean', async () => {
    as('team_leader');
    expect((await put({ managed_externally: true })).status).toBe(403);
    as('admin');
    expect((await put({ managed_externally: 'yes' })).status).toBe(400);
    expect(admin.rpcs).toEqual([]);
  });

  it('maps the SQL refusal NOT_ALLOWED to 403', async () => {
    setResult = { error: { hint: 'NOT_ALLOWED', code: '42501' } };
    expect((await put({ managed_externally: false })).status).toBe(403);
  });
});
