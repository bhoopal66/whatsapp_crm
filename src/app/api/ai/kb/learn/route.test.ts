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
import { GET, PUT } from './route';

function client(read: { data: unknown; error: unknown }, rpc = read) {
  const calls: { name: string; args: unknown }[] = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(read),
  };
  return {
    calls,
    supabase: {
      from: () => builder,
      rpc: (name: string, args: unknown) => {
        calls.push({ name, args });
        return Promise.resolve(rpc);
      },
    },
  };
}

const put = (body: unknown) =>
  new Request('http://x', { method: 'PUT', body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe('/api/ai/kb/learn', () => {
  it('is admin-only', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('no'));
    expect((await GET()).status).toBe(403);
    expect((await PUT(put({ enabled: true }))).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('reads off when no row was saved', async () => {
    const c = client({ data: null, error: null });
    mocks.requireRole.mockResolvedValue({
      supabase: c.supabase,
      accountId: 'a',
    });
    expect(await (await GET()).json()).toEqual({
      enabled: false,
      lastRunAt: null,
      available: true,
    });
  });

  it('says unavailable before migration 278', async () => {
    const c = client({ data: null, error: { code: 'PGRST205' } });
    mocks.requireRole.mockResolvedValue({
      supabase: c.supabase,
      accountId: 'a',
    });
    expect((await (await GET()).json()).available).toBe(false);
  });

  it('saves through kb_learn_set_enabled', async () => {
    const c = client(
      { data: null, error: null },
      { data: { enabled: true, last_run_at: null }, error: null }
    );
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u' });
    const res = await PUT(put({ enabled: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
    expect(c.calls).toEqual([
      { name: 'kb_learn_set_enabled', args: { p_enabled: true } },
    ]);
  });

  it('refuses a bad body', async () => {
    const c = client({ data: null, error: null });
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u' });
    expect((await PUT(put({ enabled: 'yes' }))).status).toBe(400);
    expect(c.calls).toHaveLength(0);
  });

  it('answers 403 when SQL refuses', async () => {
    const c = client(
      { data: null, error: null },
      { data: null, error: { code: '42501', message: 'not allowed' } }
    );
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u' });
    expect((await PUT(put({ enabled: true }))).status).toBe(403);
  });
});
