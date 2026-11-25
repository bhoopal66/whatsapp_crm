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

import { ForbiddenError } from '@/lib/auth/account';
import { GET } from './route';

function client(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
  chain.limit = () => Promise.resolve(result);
  return { from: () => chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/ai/kb/learn/skills', () => {
  it('is admin-only', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('no'));
    expect((await GET()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('lists the rules', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: client({
        data: [{ id: 'a', kind: 'general', title: 'T', principle: 'P' }],
        error: null,
      }),
      accountId: 'acc',
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).skills).toHaveLength(1);
  });

  it.each(['XX000', '42P01', 'PGRST205'])(
    'a failed read (%s) is a generic 500, never an empty list',
    async (code) => {
      mocks.requireRole.mockResolvedValue({
        supabase: client({
          data: null,
          error: { code, message: 'relation "kb_learn_skills" is secret' },
        }),
        accountId: 'acc',
      });
      const res = await GET();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.skills).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('kb_learn_skills');
    }
  );
});
