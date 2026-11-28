import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openai: vi.fn(),
  anthropic: vi.fn(),
  assertAiTransfer: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('./providers/openai', () => ({ generateOpenAi: mocks.openai }));
vi.mock('./providers/anthropic', () => ({
  generateAnthropic: mocks.anthropic,
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc }),
}));
vi.mock('@/lib/privacy/ai-transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/privacy/ai-transfer')>()),
  assertAiTransfer: mocks.assertAiTransfer,
}));

import { callProvider } from './provider-call';
import { AiError, type AiConfig } from './types';

const CONFIG = {
  provider: 'openai',
  model: 'gpt-std',
  apiKey: 'sk-test',
  accountId: 'acct-1',
} as AiConfig;

const call = (over: Partial<Parameters<typeof callProvider>[0]> = {}) =>
  callProvider({
    config: CONFIG,
    purpose: 'reply',
    model: 'gpt-std',
    systemPrompt: 'Be brief.',
    messages: [
      { role: 'user', content: 'My Emirates ID is 784-1990-1234567-1' },
      { role: 'assistant', content: 'Is it +971 50 123 4567?' },
    ],
    ...over,
  });

beforeEach(() => {
  mocks.openai.mockReset().mockResolvedValue({ text: 'ok', usage: null });
  mocks.anthropic.mockReset().mockResolvedValue({ text: 'ok', usage: null });
  mocks.assertAiTransfer.mockReset().mockResolvedValue(undefined);
  mocks.rpc.mockReset().mockImplementation(noCap);
});

/** The store: send_protection_caps_get answers no cap. */
function noCap(fn: string) {
  if (fn === 'send_protection_caps_get')
    return Promise.resolve({
      data: [{ daily_ai_spend_micros: null }],
      error: null,
    });
  return Promise.reject(new Error(`unexpected ${fn}`));
}

/** The store with a cap; the ledger allows or refuses every add. */
function capped(allowed: boolean) {
  return (fn: string) =>
    Promise.resolve(
      fn === 'send_protection_caps_get'
        ? { data: [{ daily_ai_spend_micros: 5_000_000 }], error: null }
        : fn === 'send_protection_spend_add'
          ? {
              data: [{ allowed, total_micros: 1, day: '2026-11-28' }],
              error: null,
            }
          : { data: 0, error: null }
    );
}

const rpcCalls = () =>
  mocks.rpc.mock.calls.map(([fn, args]) => [
    fn,
    args.p_micros,
    args.p_hard_cap,
  ]);

const ANTHROPIC = {
  ...CONFIG,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
} as AiConfig;
const USAGE = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };

describe('the daily AI spend cap', () => {
  it('no cap: one read, the call runs, the ledger is never touched', async () => {
    await call();
    expect(mocks.openai).toHaveBeenCalledTimes(1);
    expect(rpcCalls()).toEqual([
      ['send_protection_caps_get', undefined, undefined],
    ]);
  });

  it('a refused reservation: the call never runs, ai_spend_cap, nothing to settle', async () => {
    mocks.rpc.mockImplementation(capped(false));
    await expect(call()).rejects.toMatchObject({
      code: 'ai_spend_cap',
      status: 429,
    });
    expect(mocks.openai).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(([fn]) => fn)).toEqual([
      'send_protection_caps_get',
      'send_protection_spend_add',
    ]);
  });

  it('a store that fails: denied (fail closed), the call never runs', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    await expect(call()).rejects.toMatchObject({ code: 'ai_spend_cap' });
    expect(mocks.openai).not.toHaveBeenCalled();
  });

  it('reserves the priced estimate, then records the actual cost uncapped and refunds', async () => {
    mocks.rpc.mockImplementation(capped(true));
    mocks.anthropic.mockResolvedValue({ text: 'ok', usage: USAGE });
    await call({
      config: ANTHROPIC,
      model: 'claude-opus-5-5',
      systemPrompt: 'abc',
      messages: [{ role: 'user', content: 'abcdef' }],
      maxTokens: 100,
    });
    // 9 chars → 3 input tokens × 4 + 100 output × 20 = 2012 micros held;
    // spent 100 × 4 + 50 × 20 = 1400.
    expect(rpcCalls()).toEqual([
      ['send_protection_caps_get', undefined, undefined],
      ['send_protection_spend_add', 2012, 5_000_000],
      ['send_protection_spend_add', 1400, null],
      ['send_protection_spend_refund', 2012, undefined],
    ]);
  });

  it('a billed failure is recorded, then rethrown', async () => {
    mocks.rpc.mockImplementation(capped(true));
    mocks.anthropic.mockRejectedValue(
      new AiError('cut', { code: 'empty_response', usage: USAGE })
    );
    await expect(
      call({ config: ANTHROPIC, model: 'claude-opus-5-5' })
    ).rejects.toMatchObject({ code: 'empty_response' });
    expect(rpcCalls().slice(2)).toEqual([
      ['send_protection_spend_add', 1400, null],
      ['send_protection_spend_refund', expect.any(Number), undefined],
    ]);
  });

  it('an unpriced model holds and, without usage, keeps the fixed floor', async () => {
    mocks.rpc.mockImplementation(capped(true));
    await call();
    expect(rpcCalls().slice(1)).toEqual([
      ['send_protection_spend_add', 1_000, 5_000_000],
      ['send_protection_spend_add', 1_000, null],
      ['send_protection_spend_refund', 1_000, undefined],
    ]);
  });

  it('a config without an account is not checked', async () => {
    await call({ config: { ...CONFIG, accountId: undefined } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('callProvider', () => {
  it.each(['openai', 'anthropic'] as const)(
    'masks every turn before %s sees it',
    async (provider) => {
      await call({ config: { ...CONFIG, provider } });
      const { messages } = mocks[provider].mock.calls[0][0];
      expect(messages.map((m: { content: string }) => m.content)).toEqual([
        'My Emirates ID is [EID]',
        'Is it [PHONE:567]?',
      ]);
    }
  );

  it('asks the transfer register first, with the purpose and masked size', async () => {
    mocks.assertAiTransfer.mockRejectedValue(
      new AiError('no basis', { code: 'transfer_basis_required' })
    );
    await expect(call({ purpose: 'draft' })).rejects.toMatchObject({
      code: 'transfer_basis_required',
    });
    expect(mocks.openai).not.toHaveBeenCalled();
    expect(mocks.assertAiTransfer).toHaveBeenCalledWith(
      CONFIG,
      'draft',
      'gpt-std',
      'Be brief.'.length +
        'My Emirates ID is [EID]'.length +
        'Is it [PHONE:567]?'.length
    );
  });

  it('hands back the raw result, a cut-off one too', async () => {
    const raw = { text: 'half', usage: null, truncated: true };
    mocks.openai.mockResolvedValue(raw);
    expect(await call()).toBe(raw);
  });

  it('refuses an unknown provider', async () => {
    await expect(
      call({ config: { ...CONFIG, provider: 'gemini' as never } })
    ).rejects.toMatchObject({ code: 'unsupported_provider' });
  });
});

describe('the adapters have one caller', () => {
  it('only provider-call.ts imports providers/openai and providers/anthropic', () => {
    const root = path.resolve(__dirname, '../..');
    const importers = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) =>
        /(?:from|import|require)\s*\(?\s*['"][^'"]*providers\/(?:openai|anthropic)(?:\.[jt]s)?['"]/.test(
          readFileSync(path.join(root, f), 'utf8')
        )
      )
      .map((f) => f.split(path.sep).join('/'));
    expect(importers).toEqual(['lib/ai/provider-call.ts']);
  });
});
