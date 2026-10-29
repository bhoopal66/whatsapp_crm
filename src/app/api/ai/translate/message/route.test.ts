import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  translateText: vi.fn(),
  logAiUsage: vi.fn(),
  admin: null as unknown,
  limits: [] as string[],
  limitFail: null as string | null,
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
    return { success: !mocks.limitFail || !key.startsWith(mocks.limitFail) };
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

import { AiError } from '@/lib/ai/types';
import { POST } from './route';

type Result = { data: unknown; error: unknown };

/** Chainable supabase-js stand-in: one queued result per table. */
function fakeClient(results: Record<string, Result>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  return {
    calls,
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const take = () =>
        Promise.resolve(results[table] ?? { data: null, error: null });
      for (const method of ['select', 'eq', 'upsert']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      builder.maybeSingle = () => take();
      builder.then = (
        resolve: (r: Result) => unknown,
        reject: (e: unknown) => unknown
      ) => take().then(resolve, reject);
      return builder;
    },
  };
}

const ACCOUNT = 'account-1';
const MSG = '11111111-2222-4333-8444-555555555555';
const CONV = '99999999-2222-4333-8444-555555555555';
const SOURCE = 'كم سعر البطاقة؟';
const HASH = createHash('sha256').update(SOURCE, 'utf8').digest('hex');
const CONFIG = {
  provider: 'openai',
  model: 'gpt-std',
  modelSmall: 'gpt-small',
};
const USAGE = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

let scoped: ReturnType<typeof fakeClient>;
let admin: ReturnType<typeof fakeClient>;

function setup({
  message = {
    id: MSG,
    conversation_id: CONV,
    sender_type: 'customer',
    content_type: 'text',
    content_text: SOURCE,
    conversations: { account_id: ACCOUNT },
  } as unknown,
  cached = null as Result | null,
} = {}) {
  scoped = fakeClient({ messages: { data: message, error: null } });
  admin = fakeClient({
    message_translations: cached ?? { data: null, error: null },
  });
  mocks.admin = admin;
  mocks.requireRole.mockResolvedValue({
    supabase: scoped,
    accountId: ACCOUNT,
    userId: 'user-1',
    role: 'viewer',
  });
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/ai/translate/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

const upserts = () => admin.calls.filter((c) => c.method === 'upsert');

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.loadAiConfig.mockReset().mockResolvedValue(CONFIG);
  mocks.translateText.mockReset().mockResolvedValue({
    text: 'How much is the card?',
    model: 'gpt-small',
    usage: USAGE,
  });
  mocks.logAiUsage.mockReset().mockResolvedValue(undefined);
  mocks.limits = [];
  mocks.limitFail = null;
});

describe('POST /api/ai/translate/message', () => {
  it('lets a viewer in and rate-limits the user', async () => {
    setup();
    await post({ message_id: MSG });
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(mocks.limits[0]).toBe('ai-translate:user-1');
  });

  it('refuses an id that is not a UUID', async () => {
    setup();
    const res = await post({ message_id: 'msg-1' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_request');
    expect(scoped.calls).toHaveLength(0);
  });

  it('answers 404 for a message RLS hides', async () => {
    setup({ message: null });
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Message not found' });
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('answers 404 for a message in another account', async () => {
    setup({
      message: {
        id: MSG,
        conversation_id: CONV,
        sender_type: 'customer',
        content_type: 'text',
        content_text: SOURCE,
        conversations: [{ account_id: 'account-2' }],
      },
    });
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(404);
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('refuses a message with no text', async () => {
    setup({
      message: {
        id: MSG,
        conversation_id: CONV,
        sender_type: 'customer',
        content_type: 'text',
        content_text: '  ',
        conversations: { account_id: ACCOUNT },
      },
    });
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('nothing_to_translate');
  });

  it('refuses our own replies and messages that are not text or a caption', async () => {
    for (const [sender_type, content_type] of [
      ['agent', 'text'],
      ['bot', 'text'],
      ['customer', 'document'],
      ['customer', 'location'],
    ]) {
      setup({
        message: {
          id: MSG,
          conversation_id: CONV,
          sender_type,
          content_type,
          content_text: SOURCE,
          conversations: { account_id: ACCOUNT },
        },
      });
      const res = await post({ message_id: MSG });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('nothing_to_translate');
    }
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('refuses a message longer than WhatsApp allows', async () => {
    setup({
      message: {
        id: MSG,
        conversation_id: CONV,
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'ا'.repeat(4097),
        conversations: { account_id: ACCOUNT },
      },
    });
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('too_long');
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('serves a cached translation of the same text without the LLM', async () => {
    setup({
      cached: {
        data: { source_hash: HASH, translated_text: 'Cached English' },
        error: null,
      },
    });
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Cached English', cached: true });
    expect(mocks.translateText).not.toHaveBeenCalled();
    expect(mocks.loadAiConfig).not.toHaveBeenCalled();
    expect(mocks.limits).toEqual(['ai-translate:user-1']);
    expect(upserts()).toHaveLength(0);
  });

  it('re-translates an edited message and replaces the cached row', async () => {
    setup({
      cached: {
        data: { source_hash: 'stale', translated_text: 'Old English' },
        error: null,
      },
    });
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: 'How much is the card?',
      cached: false,
    });
    expect(mocks.limits).toEqual([
      'ai-translate:user-1',
      'ai-translate-acct:account-1',
    ]);
    expect(mocks.translateText).toHaveBeenCalledWith({
      config: CONFIG,
      text: SOURCE,
      target: 'en',
    });
    expect(upserts()).toHaveLength(1);
    expect(upserts()[0].args).toEqual([
      {
        message_id: MSG,
        lang: 'en',
        source_hash: HASH,
        translated_text: 'How much is the card?',
        provider: 'openai',
        model: 'gpt-small',
        account_id: ACCOUNT,
        conversation_id: CONV,
      },
      { onConflict: 'message_id,lang' },
    ]);
  });

  it('logs usage as translate with the model actually used', async () => {
    setup();
    await post({ message_id: MSG });
    expect(mocks.logAiUsage).toHaveBeenCalledWith(admin, {
      accountId: ACCOUNT,
      conversationId: CONV,
      mode: 'translate',
      provider: 'openai',
      model: 'gpt-small',
      usage: USAGE,
    });
  });

  it('treats a failed cache read as a miss and a failed write as non-fatal', async () => {
    setup({ cached: { data: null, error: { message: 'boom' } } });
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(200);
    expect((await res.json()).cached).toBe(false);
  });

  it('answers ai_not_configured when the account has no active AI', async () => {
    setup();
    mocks.loadAiConfig.mockResolvedValue(null);
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ai_not_configured');
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('maps an undecryptable key to key_decrypt_failed', async () => {
    setup();
    mocks.loadAiConfig.mockRejectedValue(new Error('bad tag'));
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('key_decrypt_failed');
  });

  it('stops at the account limit before calling the LLM', async () => {
    setup();
    mocks.limitFail = 'ai-translate-acct:';
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(429);
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it('passes a provider error through as { error, code }', async () => {
    setup();
    mocks.translateText.mockRejectedValue(
      new AiError('The AI returned no translation.', {
        code: 'translate_empty',
        status: 502,
      })
    );
    const res = await post({ message_id: MSG });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'The AI returned no translation.',
      code: 'translate_empty',
    });
    expect(upserts()).toHaveLength(0);
  });
});
