import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMBED_BATCH_MIN_MS,
  EmbeddingsDeadlineError,
  embedTexts,
  toVectorLiteral,
} from './embeddings';
import { aiRequestTimeoutMs } from './defaults';
import { AiError } from './types';

function okEmbeddings(count: number, shuffle = false): Response {
  const rows = Array.from({ length: count }, (_, i) => ({
    embedding: [i, i + 0.5],
    index: i,
  }));
  if (shuffle) rows.reverse();
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: rows }),
  } as unknown as Response;
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });
});

describe('embedTexts', () => {
  it('returns [] and makes no request for empty input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await embedTexts('sk-x', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embeds a single batch and sends the key', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length;
      return okEmbeddings(n);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await embedTexts('sk-x', ['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('api.openai.com');
    expect(
      (opts as unknown as { headers: Record<string, string> }).headers
        .Authorization
    ).toBe('Bearer sk-x');
  });

  it('splits large inputs into multiple batches', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length;
      return okEmbeddings(n);
    });
    vi.stubGlobal('fetch', fetchMock);

    const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const out = await embedTexts('sk-x', inputs);
    expect(out).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 96 + 4
  });

  it('reorders by index when the provider returns them shuffled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: { body: string }) => {
        const n = JSON.parse(opts.body).input.length;
        return okEmbeddings(n, true);
      })
    );
    const out = await embedTexts('sk-x', ['a', 'b', 'c']);
    expect(out[0]).toEqual([0, 0.5]); // index 0 first despite shuffle
    expect(out[2]).toEqual([2, 2.5]);
  });

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      } as unknown as Response)
    );
    await expect(embedTexts('sk-x', ['a'])).rejects.toMatchObject({
      code: 'invalid_key',
    });
  });

  it('throws when the provider omits result indices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ embedding: [0.1] }, { embedding: [0.2] }],
        }),
      } as unknown as Response)
    );
    await expect(embedTexts('sk-x', ['a', 'b'])).rejects.toBeInstanceOf(
      AiError
    );
  });

  it('throws on a malformed response (count mismatch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as unknown as Response)
    );
    await expect(embedTexts('sk-x', ['a', 'b'])).rejects.toBeInstanceOf(
      AiError
    );
  });

  describe('with a deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    // A slow provider: each batch takes 1.5 s of (faked) clock time.
    function slowFetch() {
      return vi.fn(async (_url: string, opts: { body: string }) => {
        vi.setSystemTime(Date.now() + 1_500);
        return okEmbeddings(JSON.parse(opts.body).input.length);
      });
    }

    it('starts no batch with too little left and throws EmbeddingsDeadlineError', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
      const fetchMock = slowFetch();
      vi.stubGlobal('fetch', fetchMock);
      const inputs = Array.from({ length: 300 }, (_, i) => `t${i}`); // 4 batches
      const deadlineAt = Date.now() + EMBED_BATCH_MIN_MS + 1_000;
      const err = await embedTexts('sk-x', inputs, { deadlineAt }).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(EmbeddingsDeadlineError);
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe('embeddings_deadline');
      // Batch 1 started with 3 s left; batch 2 would have had 1.5 s.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("cuts each batch's timeout to the time left", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
      vi.stubGlobal('fetch', slowFetch());
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const inputs = Array.from({ length: 150 }, (_, i) => `t${i}`); // 2 batches
      const out = await embedTexts('sk-x', inputs, {
        deadlineAt: Date.now() + 5_000,
      });
      expect(out).toHaveLength(150);
      expect(timeout.mock.calls.map((c) => c[0])).toEqual([5_000, 3_500]);
    });

    it('keeps the usual timeout without a deadline', async () => {
      vi.stubGlobal('fetch', slowFetch());
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      await embedTexts('sk-x', ['a']);
      expect(timeout).toHaveBeenCalledWith(aiRequestTimeoutMs());
    });
  });
});
