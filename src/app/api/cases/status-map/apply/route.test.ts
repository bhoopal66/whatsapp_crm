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

import { POST } from './route';

let admin: FakeClient;
let result: { data?: unknown; error?: unknown };
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: null };
};
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  result = { data: { moved: 4, unchanged: 1 } };
  admin = new FakeClient('admin', [], {
    case_status_map_apply: () => result as never,
  });
  m.admin = admin.client;
  as('admin');
});

describe('POST status map apply', () => {
  it('re-applies the status for the caller', async () => {
    const res = await post({ status: 'With credit' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: 4, unchanged: 1 });
    expect(admin.rpcs).toEqual([
      {
        fn: 'case_status_map_apply',
        args: { p_actor: 'u-1', p_status: 'With credit' },
      },
    ]);
  });

  it('needs a status of at most 64 characters', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ status: 'x'.repeat(65) })).status).toBe(400);
    expect(admin.rpcs).toEqual([]);
  });

  it('answers a HINT refusal with 422 and its code', async () => {
    result = { error: { hint: 'STAGE_NOT_CONFIGURED', code: '23514' } };
    const res = await post({ status: 'With credit' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Stage not configured for this bank',
      code: 'STAGE_NOT_CONFIGURED',
    });
  });

  it('answers 403 to a team leader', async () => {
    as('team_leader');
    expect((await post({ status: 'x' })).status).toBe(403);
    expect(admin.rpcs).toEqual([]);
  });
});
