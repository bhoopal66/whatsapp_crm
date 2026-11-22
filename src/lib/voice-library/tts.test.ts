import { describe, expect, it, vi } from 'vitest';

import type { AiConfig } from '@/lib/ai/types';

import {
  TTS_MODEL,
  TTS_PURPOSE,
  TTS_URL,
  resolveTtsKey,
  synthesizeSpeech,
} from './tts';

const allow = vi.fn(async () => true);

function okFetch(bytes = new Uint8Array([79, 103, 103, 83])) {
  return vi.fn(
    async () => new Response(bytes, { status: 200 })
  ) as unknown as typeof fetch;
}

const base = {
  accountId: 'acc-1',
  apiKey: 'sk-test',
  text: 'Hello Aisha',
  voice: 'coral' as const,
  language: 'ar' as const,
};

describe('synthesizeSpeech', () => {
  it('asks OpenAI for Ogg/Opus and returns the bytes', async () => {
    const fetchImpl = okFetch();
    const check = vi.fn(async () => true);
    const out = await synthesizeSpeech({
      ...base,
      fetchImpl,
      transferCheck: check,
    });
    expect(Array.from(out)).toEqual([79, 103, 103, 83]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe(TTS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test'
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: TTS_MODEL,
      voice: 'coral',
      input: 'Hello Aisha',
      response_format: 'opus',
    });
    expect(body.instructions).toContain('Arabic');
    expect(check).toHaveBeenCalledWith({
      accountId: 'acc-1',
      destination: 'openai',
      purpose: TTS_PURPOSE,
      model: TTS_MODEL,
      bytes: 'Hello Aisha'.length,
    });
  });

  it('never calls OpenAI when the transfer register refuses', async () => {
    const fetchImpl = okFetch();
    await expect(
      synthesizeSpeech({
        ...base,
        fetchImpl,
        transferCheck: async () => false,
      })
    ).rejects.toMatchObject({ code: 'transfer_basis_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names a refused key without echoing the provider body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"Hello Aisha"}', { status: 401 })
    ) as unknown as typeof fetch;
    const err = await synthesizeSpeech({
      ...base,
      fetchImpl,
      transferCheck: allow,
    }).catch((e) => e);
    expect(err.code).toBe('tts_key_refused');
    expect(err.message).not.toContain('Aisha');
  });

  it('treats an empty body and a network failure as failures', async () => {
    await expect(
      synthesizeSpeech({
        ...base,
        fetchImpl: okFetch(new Uint8Array()),
        transferCheck: allow,
      })
    ).rejects.toMatchObject({ code: 'tts_failed' });
    await expect(
      synthesizeSpeech({
        ...base,
        fetchImpl: vi.fn(async () => {
          throw new Error('down');
        }) as unknown as typeof fetch,
        transferCheck: allow,
      })
    ).rejects.toMatchObject({ code: 'tts_unreachable' });
  });
});

describe('resolveTtsKey', () => {
  const cfg = (over: Partial<AiConfig>) =>
    ({
      provider: 'openai',
      apiKey: 'sk-main',
      embeddingsApiKey: null,
      ...over,
    }) as AiConfig;

  it('uses the OpenAI assistant key, else the embeddings key', () => {
    expect(resolveTtsKey(cfg({}))).toEqual({ ok: true, apiKey: 'sk-main' });
    expect(
      resolveTtsKey(
        cfg({ provider: 'anthropic', embeddingsApiKey: 'sk-embed' })
      )
    ).toEqual({ ok: true, apiKey: 'sk-embed' });
  });

  it('gives a reason when there is no OpenAI key', () => {
    expect(resolveTtsKey(null)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    expect(resolveTtsKey(cfg({ provider: 'anthropic' }))).toEqual({
      ok: false,
      reason: 'no_openai_key',
    });
  });
});
