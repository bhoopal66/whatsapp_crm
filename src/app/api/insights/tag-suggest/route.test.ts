import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  suggest: vi.fn(),
  read: vi.fn(),
  rpc: vi.fn(),
  eqs: [] as [string, unknown][],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/insights/suggest-now', () => ({
  suggestTagForConversation: mocks.suggest,
}));

import { __resetRateLimitForTests, RATE_LIMITS } from '@/lib/rate-limit';
import { POST } from './route';

const CONV = '11111111-1111-4111-8111-111111111111';

function scopedClient() {
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      mocks.eqs.push([col, val]);
      return chain;
    },
    maybeSingle: () => mocks.read(),
  };
  return { from: vi.fn(() => chain), rpc: mocks.rpc };
}

let auth: {
  supabase: ReturnType<typeof scopedClient>;
  accountId: string;
  userId: string;
  role: string;
};

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/insights/tag-suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  auth = {
    supabase: scopedClient(),
    accountId: 'account-1',
    userId: 'user-1',
    role: 'agent',
  };
  mocks.requireRole.mockReset().mockImplementation(async () => auth);
  mocks.suggest.mockReset();
  mocks.read.mockReset().mockResolvedValue({ data: { id: CONV }, error: null });
  mocks.rpc.mockReset().mockResolvedValue({ data: true, error: null });
  mocks.eqs.length = 0;
});

describe('POST /api/insights/tag-suggest', () => {
  it('requires an agent and answers the auth error otherwise', async () => {
    mocks.requireRole.mockRejectedValue(new Error('viewer'));
    const res = await post({ conversationId: CONV });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(res.status).toBe(403);
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', 'not json'],
    ['no id', {}],
    ['a malformed id', { conversationId: 'abc' }],
  ])('is 400 on %s', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it('is 404 when the caller cannot see the chat, before asking Jev', async () => {
    mocks.read.mockResolvedValue({ data: null, error: null });
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Chat not found' });
    expect(mocks.suggest).not.toHaveBeenCalled();
    // Read through the caller's own client, in their account.
    expect(auth.supabase.from).toHaveBeenCalledWith('conversations');
    expect(mocks.eqs).toEqual([
      ['id', CONV],
      ['account_id', 'account-1'],
    ]);
  });

  it('is 500 when the visibility read fails', async () => {
    mocks.read.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(500);
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it('answers the suggestion', async () => {
    const suggestion = { mainId: 'm', subId: 's', p: 0.82 };
    mocks.suggest.mockResolvedValue({ ok: true, suggestion });
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion });
    expect(mocks.suggest).toHaveBeenCalledWith('account-1', CONV);
  });

  it('answers no suggestion with its reason', async () => {
    mocks.suggest.mockResolvedValue({
      ok: true,
      suggestion: null,
      reason: 'not_confident',
    });
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suggestion: null,
      reason: 'not_confident',
    });
  });

  it.each([
    ['off', 409],
    ['unavailable', 503],
    ['error', 502],
  ] as const)(
    'answers %s as %s with { error, reason }',
    async (reason, status) => {
      mocks.suggest.mockResolvedValue({ ok: false, reason });
      const res = await post({ conversationId: CONV });
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.reason).toBe(reason);
      expect(typeof body.error).toBe('string');
    }
  );

  it('rate-limits per person', async () => {
    mocks.suggest.mockResolvedValue({
      ok: true,
      suggestion: null,
      reason: 'no_message',
    });
    for (let i = 0; i < RATE_LIMITS.tagSuggestUser.limit; i++) {
      expect((await post({ conversationId: CONV })).status).toBe(200);
    }
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(429);
    expect(mocks.suggest).toHaveBeenCalledTimes(
      RATE_LIMITS.tagSuggestUser.limit
    );

    // Another person has their own budget.
    auth = { ...auth, userId: 'user-2' };
    expect((await post({ conversationId: CONV })).status).toBe(200);
  });
  it('refuses a viewer of the chat who could not act on a suggestion (a coordinator share)', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(404);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'can_view_conversation',
      expect.any(Object)
    );
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it('answers 500 when the visibility check fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(500);
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it('lets an admin through without the visibility check, as dismiss does', async () => {
    auth.role = 'admin';
    mocks.suggest.mockResolvedValue({
      ok: true,
      suggestion: null,
      reason: 'not_confident',
    });
    const res = await post({ conversationId: CONV });
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
