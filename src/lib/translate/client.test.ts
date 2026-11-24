import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedMessageTranslation,
  resetTranslationCache,
  translateDraft,
  translateDraftErrorKey,
  translateMessage,
} from './client';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => resetTranslationCache());

describe('translateMessage', () => {
  it('posts the message id and returns the English text', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { text: ' Hello ' }));
    const result = await translateMessage('m1', 'مرحبا', fetchImpl);
    expect(result).toEqual({ ok: true, text: 'Hello' });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/ai/translate/message',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message_id: 'm1' }),
      })
    );
  });

  it('serves a repeat from the session cache', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { text: 'Hello' }));
    await translateMessage('m1', 'مرحبا', fetchImpl);
    expect(cachedMessageTranslation('m1', 'مرحبا')).toBe('Hello');
    expect(await translateMessage('m1', 'مرحبا', fetchImpl)).toEqual({
      ok: true,
      text: 'Hello',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks again when the message text changed', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { text: 'Hello' }));
    await translateMessage('m1', 'مرحبا', fetchImpl);
    await translateMessage('m1', 'مرحبا بك', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const a = translateMessage('m1', 'مرحبا', fetchImpl);
    const b = translateMessage('m1', 'مرحبا', fetchImpl);
    resolve(reply(200, { text: 'Hello' }));
    expect(await a).toEqual({ ok: true, text: 'Hello' });
    expect(await b).toEqual({ ok: true, text: 'Hello' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes the route error through and caches nothing', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(400, { error: 'AI is not set up.', code: 'ai_not_configured' })
    );
    expect(await translateMessage('m1', 'مرحبا', fetchImpl)).toEqual({
      ok: false,
      code: 'ai_not_configured',
      error: 'AI is not set up.',
    });
    expect(cachedMessageTranslation('m1', 'مرحبا')).toBeNull();
    await translateMessage('m1', 'مرحبا', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a network failure and an empty answer', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await translateMessage('m1', 'مرحبا', down)).toEqual({
      ok: false,
      code: 'network',
      error: null,
    });
    const blank = vi.fn(async () => reply(200, { text: '  ' }));
    expect(await translateMessage('m2', 'مرحبا', blank)).toEqual({
      ok: false,
      code: 'empty',
      error: null,
    });
  });

  it('copes with a non-JSON error body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>502</html>', { status: 502 })
    );
    expect(await translateMessage('m1', 'مرحبا', fetchImpl)).toEqual({
      ok: false,
      code: null,
      error: null,
    });
  });
});

describe('translateDraft', () => {
  it('posts the draft for Arabic and never caches it', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { text: 'مرحبا' }));
    expect(await translateDraft('Hello', 'c1', fetchImpl)).toEqual({
      ok: true,
      text: 'مرحبا',
    });
    await translateDraft('Hello', 'c1', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/ai/translate',
      expect.objectContaining({
        body: JSON.stringify({
          text: 'Hello',
          conversation_id: 'c1',
          target: 'ar',
        }),
      })
    );
  });
});

describe('translateDraftErrorKey', () => {
  it.each([
    ['ai_not_configured', 'translateNotConfigured'],
    ['translate_unsafe', 'translateUnsafe'],
    ['network', 'translateFailed'],
    [null, 'translateFailed'],
  ])('%s -> %s', (code, key) => {
    expect(translateDraftErrorKey(code)).toBe(key);
  });
});
