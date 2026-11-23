import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BodyTooLargeError, readCapped, streamCapped } from './capped-body';
import { openMedia as openMeta } from '@/lib/whatsapp/meta-api';
import { downloadMedia as metaDownload } from '@/lib/whatsapp/meta-api';
import { downloadMedia as openwaDownload } from '@/lib/whatsapp/openwa-api';
import { downloadMedia as whapiDownload } from '@/lib/whatsapp/whapi-api';

const KB = 1024;

/** A far too long body; `pulled` counts the chunks it was asked for. */
function endless() {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      state.pulled += 1;
      if (state.pulled > 2000) return c.close();
      c.enqueue(new Uint8Array(KB));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, body };
}

afterEach(() => vi.unstubAllGlobals());

describe('readCapped', () => {
  it('returns a body of exactly the limit', async () => {
    const out = await readCapped(new Response(new Uint8Array(KB)), KB);
    expect(out.byteLength).toBe(KB);
  });

  it('refuses the declared size without reading', async () => {
    const { state, body } = endless();
    const res = new Response(body, { headers: { 'content-length': '5000' } });
    await expect(readCapped(res, KB)).rejects.toMatchObject({
      name: 'BodyTooLargeError',
      bytes: 5000,
    });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it('counts while reading and cancels past the limit', async () => {
    const { state, body } = endless();
    const res = new Response(body, { headers: { 'content-length': '10' } });
    await expect(readCapped(res, 4 * KB)).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10);
  });

  it('answers an empty body', async () => {
    expect((await readCapped(new Response(null), KB)).byteLength).toBe(0);
  });
});

describe('streamCapped', () => {
  it('passes the bytes and their declared length', async () => {
    const out = await streamCapped(
      new Response('bytes', { headers: { 'content-length': '5' } }),
      KB
    );
    expect(out.contentLength).toBe(5);
    expect(await new Response(out.body).text()).toBe('bytes');
  });

  it('breaks the transfer past the limit', async () => {
    const { state, body } = endless();
    const out = await streamCapped(new Response(body), 4 * KB);
    await expect(new Response(out.body).arrayBuffer()).rejects.toThrow();
    expect(state.pulled).toBeLessThan(12);
  });
});

describe('every gateway download stops at the cap', () => {
  const ROUTES = {
    meta: (maxBytes: number) =>
      metaDownload({
        downloadUrl: 'https://lookaside.fbsbx.com/x',
        accessToken: 't',
        maxBytes,
      }),
    whapi: (maxBytes: number) =>
      whapiDownload({
        downloadUrl: 'https://gate.whapi.cloud/media/x',
        token: 't',
        maxBytes,
      }),
    openwa: (maxBytes: number) =>
      openwaDownload({
        apiKey: 'k',
        sessionId: 's',
        downloadUrl: `${process.env.OPENWA_URL}/api/sessions/s/messages/c/m/media`,
        maxBytes,
      }),
  };

  it.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])('%s', async (k) => {
    vi.stubEnv('OPENWA_URL', 'http://127.0.0.1:2785');
    const { state, body } = endless();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    await expect(ROUTES[k](4 * KB)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(state.cancelled).toBe(true);
    vi.unstubAllEnvs();
  });

  it('an under-cap file is unchanged, and openMedia leaves it unread', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bytes'))
    );
    expect((await ROUTES.meta(KB)).buffer.toString()).toBe('bytes');
    const res = await openMeta({
      downloadUrl: 'https://lookaside.fbsbx.com/x',
      accessToken: 't',
      maxBytes: KB,
    });
    expect(res.bodyUsed).toBe(false);
  });
});

describe('guardedRequest limits what a compressed body unpacks to', () => {
  it('errors past the limit and serves the rest', async () => {
    const http = await import('node:http');
    const { guardedRequest } = await import('@/lib/webhooks/safe-fetch');
    const zipped = gzipSync(Buffer.alloc(4 * 1024 * KB));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(zipped);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const get = (maxDecodedBytes?: number) =>
      guardedRequest(
        `http://127.0.0.1:${port}/`,
        {},
        { isBlocked: () => false, maxDecodedBytes }
      );
    try {
      expect(zipped.byteLength).toBeLessThan(64 * KB);
      await expect((await get(64 * KB)).arrayBuffer()).rejects.toBeInstanceOf(
        BodyTooLargeError
      );
      const whole = await (await get()).arrayBuffer();
      expect(whole.byteLength).toBe(4 * 1024 * KB);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
