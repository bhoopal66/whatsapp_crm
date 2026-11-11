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
import { POST } from './route';

function client(result: { data: unknown; error: unknown }) {
  const inserted: unknown[] = [];
  const builder: Record<string, unknown> = {
    insert: (row: unknown) => {
      inserted.push(row);
      return builder;
    },
    select: () => builder,
    single: () => Promise.resolve(result),
  };
  return { supabase: { from: () => builder }, inserted };
}

const post = (body: unknown) =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe('POST /api/ai/kb (start an answer from a question)', () => {
  it('redacts identifiers in the question before storing it', async () => {
    const c = client({ data: { id: 'e1' }, error: null });
    mocks.requireRole.mockResolvedValue({
      supabase: c.supabase,
      accountId: 'acc-1',
      userId: 'u1',
    });
    const res = await POST(
      post({
        question:
          'My Emirates ID is 784-1990-1234567-1, mail me at a.b@example.com',
      })
    );
    expect(res.status).toBe(201);
    const { question } = c.inserted[0] as { question: string };
    expect(question).not.toContain('1234567');
    expect(question).not.toContain('a.b@example.com');
    expect(question).toContain('My Emirates ID is');
  });

  it('inserts a draft with a generated GAP ref in the caller account', async () => {
    const c = client({ data: { id: 'e1', question: 'Q?' }, error: null });
    mocks.requireRole.mockResolvedValue({
      supabase: c.supabase,
      accountId: 'acc-1',
      userId: 'u1',
    });
    const res = await POST(post({ question: '  Q?  ' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ entry: { id: 'e1', question: 'Q?' } });
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    const row = c.inserted[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      account_id: 'acc-1',
      audience: 'prospective_client',
      question: 'Q?',
      status: 'draft',
    });
    expect(row.ref).toMatch(/^GAP-[0-9A-F]{6}$/);
  });

  it('refuses a blank question', async () => {
    const c = client({ data: null, error: null });
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u1' });
    expect((await POST(post({ question: '  ' }))).status).toBe(400);
    expect(c.inserted).toHaveLength(0);
  });

  it('is a 403 below admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('admin only'));
    expect((await POST(post({ question: 'Q?' }))).status).toBe(403);
  });
});
