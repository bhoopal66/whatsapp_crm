import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    requireRole: mocks.requireRole,
    assertSalesAccess: (c: unknown) => c,
    ForbiddenError: actual.ForbiddenError,
    toErrorResponse: actual.toErrorResponse,
  };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

import { ForbiddenError } from '@/lib/auth/account';
import { PATCH } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const patch = (body: unknown, id = ID) =>
  PATCH(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
    {
      params: Promise.resolve({ id }),
    }
  );

function client(rpc: { data: unknown; error: unknown }) {
  const calls: unknown[] = [];
  return {
    calls,
    supabase: {
      rpc: (name: string, args: unknown) => {
        calls.push({ name, args });
        return Promise.resolve(rpc);
      },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('PATCH /api/ai/kb/learn/skills/[id]', () => {
  it('is admin-only', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('no'));
    expect((await patch({ status: 'retired' })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('retires through kb_learn_skill_set_status', async () => {
    const c = client({ data: { id: ID, status: 'retired' }, error: null });
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u' });
    const res = await patch({ status: 'retired' });
    expect(res.status).toBe(200);
    expect(c.calls).toEqual([
      {
        name: 'kb_learn_skill_set_status',
        args: { p_skill: ID, p_status: 'retired' },
      },
    ]);
  });

  it('refuses a bad id or status without a call', async () => {
    const c = client({ data: null, error: null });
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u' });
    expect((await patch({ status: 'gone' })).status).toBe(400);
    expect((await patch({ status: 'retired' }, 'nope')).status).toBe(404);
    expect(c.calls).toHaveLength(0);
  });

  it('maps SQL refusals', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: client({ data: null, error: { code: '42501' } }).supabase,
      userId: 'u',
    });
    expect((await patch({ status: 'retired' })).status).toBe(404);
    mocks.requireRole.mockResolvedValue({
      supabase: client({
        data: null,
        error: { code: '23514', hint: 'SKILL_CAP' },
      }).supabase,
      userId: 'u',
    });
    expect((await patch({ status: 'active' })).status).toBe(409);
  });

  it('an unexpected database error is a generic 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.requireRole.mockResolvedValue({
      supabase: client({
        data: null,
        error: { code: 'XX000', message: 'kb_learn_skills internals' },
      }).supabase,
      userId: 'u',
    });
    const res = await patch({ status: 'retired' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('kb_learn_skills');
  });

  it('a skill the function does not return is a 404, not a 200 null', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: client({ data: null, error: null }).supabase,
      userId: 'u',
    });
    expect((await patch({ status: 'retired' })).status).toBe(404);
  });
});
