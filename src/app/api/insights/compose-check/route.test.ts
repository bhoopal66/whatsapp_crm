import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkDraft: vi.fn(),
  rate: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/insights/compose-check', () => ({
  checkDraft: mocks.checkDraft,
  COMPOSE_CHECK_BUDGET_MS: 1800,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.rate,
  rateLimitResponse: () => Response.json({ error: 'slow' }, { status: 429 }),
  RATE_LIMITS: { composeCheckUser: { limit: 30, windowMs: 60_000 } },
}));

import { POST } from './route';

const CONV = '6f1c2a34-1b2c-4d5e-8f90-123456789abc';

function fakeDb(visible: boolean) {
  const filters: [string, unknown][] = [];
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (c: string, v: unknown) => {
    filters.push([c, v]);
    return b;
  };
  b.maybeSingle = async () => ({
    data: visible ? { id: CONV } : null,
    error: null,
  });
  return { db: { from: () => b }, filters };
}

let fake: ReturnType<typeof fakeDb>;
function useDb(visible = true) {
  fake = fakeDb(visible);
  mocks.requireRole.mockResolvedValue({
    supabase: fake.db,
    accountId: 'account-1',
    userId: 'user-1',
    role: 'agent',
  });
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/insights/compose-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.checkDraft.mockReset();
  mocks.rate.mockReset();
  mocks.rate.mockReturnValue({ success: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useDb();
});

describe('POST /api/insights/compose-check', () => {
  it('refuses a viewer (requires agent)', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await post({ conversationId: CONV, text: 'hello there' });
    expect(res.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.checkDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['bad uuid', { conversationId: 'nope', text: 'hi' }],
    ['no text', { conversationId: CONV }],
    ['text not a string', { conversationId: CONV, text: 5 }],
    ['text too long', { conversationId: CONV, text: 'a'.repeat(4097) }],
  ])('400 on %s', async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mocks.checkDraft).not.toHaveBeenCalled();
  });

  it('429 when rate limited, keyed by user', async () => {
    mocks.rate.mockReturnValue({ success: false });
    const res = await post({ conversationId: CONV, text: 'hello there' });
    expect(res.status).toBe(429);
    expect(mocks.rate.mock.calls[0][0]).toContain('user-1');
    expect(mocks.checkDraft).not.toHaveBeenCalled();
  });

  it('404 when the conversation is not visible', async () => {
    useDb(false);
    const res = await post({ conversationId: CONV, text: 'hello there' });
    expect(res.status).toBe(404);
    expect(fake.filters).toEqual([
      ['id', CONV],
      ['account_id', 'account-1'],
    ]);
    expect(mocks.checkDraft).not.toHaveBeenCalled();
  });

  it('passes the deadline and returns the check result', async () => {
    const result = {
      warnings: [{ code: 'promise', source: 'rule' }],
      eventId: 'evt-1',
    };
    mocks.checkDraft.mockResolvedValue(result);
    const before = Date.now();
    const res = await post({ conversationId: CONV, text: 'guaranteed!' });
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    const args = mocks.checkDraft.mock.calls[0][0];
    expect(args).toMatchObject({
      accountId: 'account-1',
      userId: 'user-1',
      conversationId: CONV,
      text: 'guaranteed!',
      db: fake.db,
    });
    expect(args.deadlineAt).toBeGreaterThanOrEqual(before + 1800);
    expect(args.deadlineAt).toBeLessThanOrEqual(after + 1800);
  });
});
