import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  translateText: vi.fn(),
  logAiUsage: vi.fn(),
  admin: null as unknown,
  limits: [] as string[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn((key: string) => {
    mocks.limits.push(key);
    return { success: true };
  }),
  rateLimitResponse: vi.fn(() =>
    Response.json({ error: 'slow down' }, { status: 429 })
  ),
  RATE_LIMITS: { aiTranslate: {}, aiTranslateAccount: {} },
}));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocks.admin }));
vi.mock('@/lib/ai/translate', () => ({ translateText: mocks.translateText }));
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }));

import { POST } from './route';

type Result = { data: unknown; error: unknown };

function fakeClient(results: Record<string, Result>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  return {
    calls,
    from(table: string) {
      calls.push({ table, method: 'from', args: [] });
      const builder: Record<string, unknown> = {};
      const take = () =>
        Promise.resolve(results[table] ?? { data: null, error: null });
      for (const method of ['select', 'eq', 'upsert', 'insert']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      builder.maybeSingle = () => take();
      return builder;
    },
  };
}

const ACCOUNT = 'account-1';
const CONV = '99999999-2222-4333-8444-555555555555';
const CONFIG = { provider: 'anthropic', model: 'claude-std' };
const USAGE = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

let scoped: ReturnType<typeof fakeClient>;
let admin: ReturnType<typeof fakeClient>;

function setup(conversation: unknown = { id: CONV, account_id: ACCOUNT }) {
  scoped = fakeClient({ conversations: { data: conversation, error: null } });
  admin = fakeClient({});
  mocks.admin = admin;
  mocks.requireRole.mockResolvedValue({
    supabase: scoped,
    accountId: ACCOUNT,
    userId: 'user-1',
    role: 'agent',
  });
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

const DRAFT = {
  text: 'Your card ships tomorrow.',
  conversation_id: CONV,
  target: 'ar',
};

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.loadAiConfig.mockReset().mockResolvedValue(CONFIG);
  mocks.translateText
    .mockReset()
    .mockResolvedValue({
      text: 'ستُشحن بطاقتك غداً.',
      model: 'claude-std',
      usage: USAGE,
    });
  mocks.logAiUsage.mockReset().mockResolvedValue(undefined);
  mocks.limits = [];
});

describe('POST /api/ai/translate', () => {
  it('needs an agent', async () => {
    setup();
    await post(DRAFT);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.limits[0]).toBe('ai-translate:user-1');
  });

  it.each([
    [{ ...DRAFT, target: 'en' }],
    [{ ...DRAFT, target: undefined }],
    [{ ...DRAFT, text: '   ' }],
    [{ ...DRAFT, text: 42 }],
    [{ ...DRAFT, conversation_id: 'conv-1' }],
  ])('refuses %j', async (body) => {
    setup();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_request');
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('refuses a draft longer than WhatsApp allows', async () => {
    setup();
    const res = await post({ ...DRAFT, text: 'a'.repeat(4097) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('too_long');
  });

  it('answers 404 for a conversation RLS hides', async () => {
    setup(null);
    const res = await post(DRAFT);
    expect(res.status).toBe(404);
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('answers 404 for a conversation in another account', async () => {
    setup({ id: CONV, account_id: 'account-2' });
    const res = await post(DRAFT);
    expect(res.status).toBe(404);
  });

  it('answers ai_not_configured when the account has no active AI', async () => {
    setup();
    mocks.loadAiConfig.mockResolvedValue(null);
    const res = await post(DRAFT);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ai_not_configured');
  });

  it('returns the Arabic, logs usage and stores nothing', async () => {
    setup();
    const res = await post(DRAFT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'ستُشحن بطاقتك غداً.' });
    expect(mocks.translateText).toHaveBeenCalledWith({
      config: CONFIG,
      text: DRAFT.text,
      target: 'ar',
    });
    expect(mocks.limits).toEqual([
      'ai-translate:user-1',
      'ai-translate-acct:account-1',
    ]);
    expect(mocks.logAiUsage).toHaveBeenCalledWith(admin, {
      accountId: ACCOUNT,
      conversationId: CONV,
      mode: 'translate',
      provider: 'anthropic',
      model: 'claude-std',
      usage: USAGE,
    });
    const tables = [...scoped.calls, ...admin.calls].map((c) => c.table);
    expect(tables).not.toContain('message_translations');
  });
});
