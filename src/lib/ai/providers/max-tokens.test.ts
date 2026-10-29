import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import { generateAnthropic } from './anthropic';
import { generateOpenAi } from './openai';
import type { ProviderArgs } from './shared';

// The adapters' output cap: MAX_OUTPUT_TOKENS unless the caller asks for
// more (translation does, since Arabic output is token-heavy).

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const base: ProviderArgs = {
  apiKey: 'k',
  model: 'm',
  systemPrompt: 's',
  messages: [{ role: 'user', content: 'hi' }],
  timeoutMs: 1000,
};

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as Response;
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe('OpenAI output cap', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      ok({ choices: [{ message: { content: 'x' } }] })
    );
  });

  it('defaults to MAX_OUTPUT_TOKENS', async () => {
    await generateOpenAi(base);
    expect(sentBody().max_completion_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('honours maxTokens', async () => {
    await generateOpenAi({ ...base, maxTokens: 4096 });
    expect(sentBody().max_completion_tokens).toBe(4096);
  });
});

describe('Anthropic output cap', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(ok({ content: [{ type: 'text', text: 'x' }] }));
  });

  it('defaults to MAX_OUTPUT_TOKENS', async () => {
    await generateAnthropic(base);
    expect(sentBody().max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('honours maxTokens', async () => {
    await generateAnthropic({ ...base, maxTokens: 4096 });
    expect(sentBody().max_tokens).toBe(4096);
  });
});
