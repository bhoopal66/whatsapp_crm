import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { guardedRequest, UnsafeUrlError, type Resolver } from './safe-fetch';
import { safeFetch } from './ssrf';

// DNS rebinding: the attacker's DNS answers a public address to
// `isDeliverableUrl` and a private one when fetch resolves the name
// again. The guard must therefore sit on the connection itself. A local
// server on 127.0.0.1 stands in for the internal target: it must never
// see a connection unless the test explicitly allows its address.

let server: http.Server;
let port: number;
let connections = 0;
let lastRequest: { method?: string; host?: string; body: string } | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = { method: req.method, host: req.headers.host, body };
      res.writeHead(201, { 'content-type': 'text/plain', 'x-probe': 'yes' });
      res.end('internal secret');
    });
  });
  server.on('connection', () => connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  connections = 0;
  lastRequest = null;
});

const answers =
  (...ips: string[]): Resolver =>
  async () =>
    ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('safeFetch — the connection itself refuses private addresses', () => {
  it('refuses a name that resolves private at connect time', async () => {
    // A public answer for the earlier check, then the rebinding flip.
    let calls = 0;
    const rebinding: Resolver = async () => [
      { address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 },
    ];
    // The earlier, separate check sees the public answer...
    expect((await rebinding('rebind.test'))[0].address).toBe('93.184.216.34');
    // ...and the connect-time resolution sees the private one.
    await expect(
      safeFetch(`http://rebind.test:${port}/`, {}, { resolve: rebinding })
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(calls).toBe(2);
    expect(connections).toBe(0);
  });

  it('refuses when any one of several answers is private', async () => {
    await expect(
      safeFetch(
        `http://mixed.test:${port}/`,
        { method: 'POST', body: 'x' },
        { resolve: answers('8.8.8.8', '169.254.169.254') }
      )
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(connections).toBe(0);
  });

  it('refuses a literal private IP without resolving it', async () => {
    let resolved = false;
    const resolve: Resolver = async () => {
      resolved = true;
      return [{ address: '8.8.8.8', family: 4 }];
    };
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, {}, { resolve })
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      safeFetch(`http://[::ffff:127.0.0.1]:${port}/`, {}, { resolve })
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(resolved).toBe(false);
    expect(connections).toBe(0);
  });

  it('refuses a non-http scheme', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(
      UnsafeUrlError
    );
  });
});

describe('guardedRequest — an allowed address', () => {
  const allowAll = { isBlocked: () => false };

  it('connects to the vetted address and keeps the URL host as Host', async () => {
    const res = await guardedRequest(
      `http://allowed.test:${port}/hook?a=1`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"ok":1}',
      },
      { ...allowAll, resolve: answers('127.0.0.1') }
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.headers.get('x-probe')).toBe('yes');
    expect(await res.text()).toBe('internal secret');
    expect(lastRequest).toEqual({
      method: 'POST',
      host: `allowed.test:${port}`,
      body: '{"ok":1}',
    });
    expect(connections).toBe(1);
  });

  it('rejects with the signal reason on timeout', async () => {
    const slow = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const slowPort = (slow.address() as AddressInfo).port;
    try {
      await expect(
        guardedRequest(
          `http://127.0.0.1:${slowPort}/`,
          { signal: AbortSignal.timeout(50) },
          allowAll
        )
      ).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((r) => slow.close(() => r()));
    }
  });
});

describe('guardedRequest — Content-Encoding', () => {
  const allowAll = { isBlocked: () => false, resolve: answers('127.0.0.1') };
  const payload = 'compressed '.repeat(200);
  let enc: http.Server;
  let encPort: number;

  beforeAll(async () => {
    enc = http.createServer((req, res) => {
      const kind = req.url?.slice(1) ?? '';
      const encoders: Record<string, (b: Buffer) => Buffer> = {
        gzip: zlib.gzipSync,
        'x-gzip': zlib.gzipSync,
        deflate: zlib.deflateSync,
        br: zlib.brotliCompressSync,
        weird: (b) => b,
      };
      const body = encoders[kind](Buffer.from(payload));
      res.writeHead(200, {
        'content-encoding': kind === 'x-gzip' ? 'X-GZIP' : kind,
        'content-length': String(body.length),
      });
      res.end(body);
    });
    await new Promise<void>((r) => enc.listen(0, '127.0.0.1', r));
    encPort = (enc.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => enc.close(() => r()));
  });

  it.each(['gzip', 'x-gzip', 'deflate', 'br'])(
    'decodes a %s body and drops the stale headers',
    async (kind) => {
      const res = await guardedRequest(
        `http://enc.test:${encPort}/${kind}`,
        {},
        allowAll
      );
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(res.headers.get('content-length')).toBeNull();
      expect(await res.text()).toBe(payload);
    }
  );

  it('refuses an encoding it cannot decode', async () => {
    await expect(
      guardedRequest(`http://enc.test:${encPort}/weird`, {}, allowAll)
    ).rejects.toThrow(/content-encoding/i);
  });
});
