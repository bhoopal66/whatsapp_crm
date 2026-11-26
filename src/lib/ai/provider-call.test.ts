import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openai: vi.fn(),
  anthropic: vi.fn(),
  assertAiTransfer: vi.fn(),
}));

vi.mock('./providers/openai', () => ({ generateOpenAi: mocks.openai }));
vi.mock('./providers/anthropic', () => ({
  generateAnthropic: mocks.anthropic,
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
