// ============================================================
// Address-pinned HTTP transport for the SSRF guard (`ssrf.ts`).
//
// `isDeliverableUrl` resolves a host and vets the answer, but a plain
// `fetch(url)` afterwards resolves the name a second time. An attacker
// who controls the DNS (TTL 0) answers a public address to the check
// and 127.0.0.1 / 169.254.169.254 / an internal host to the fetch — DNS
// rebinding. The fix is to vet the address the socket actually connects
// to, so the check and the connect cannot diverge.
//
// Node's global fetch (undici) only takes a pinned resolver through an
// undici `Agent`, and undici is not a declared dependency. So this is a
// small fetch-shaped request on `node:http` / `node:https` whose
// `lookup` hook resolves the name, refuses the connection if ANY
// answer is blocked, and hands only vetted addresses to the socket.
// The URL's hostname still drives the Host header and TLS SNI, so
// virtual hosts and certificate checks behave as before. An IP-literal
// URL never reaches `lookup` (net connects to it directly), so it is
// checked up front.
//
// Deliberate differences from fetch: redirects are never followed
// (callers already ask for `redirect: 'manual'`), no Accept-Encoding is
// sent but a gzip / deflate / br body that arrives anyway is decoded
// (fetch did; callers mirror the bytes), and every request gets its own
// socket (`agent: false`) — a pooled keep-alive socket could have been
// opened by code that never went through this guard.
//
// Lives apart from `ssrf.ts` (which wraps it as `safeFetch`) so tests
// that drive `fetchPublicUrl` can stub the transport with `vi.mock`.
// ============================================================

import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable, type Transform } from 'node:stream';
import zlib from 'node:zlib';

/** Thrown when a URL or a resolved address fails the SSRF guard. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** Resolves a hostname to every address it answers. */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export interface GuardedRequestOptions {
  /** True for an address the socket must never connect to. */
  isBlocked: (ip: string) => boolean;
  /** Name resolution; defaults to `dns.lookup` (injectable for tests). */
  resolve?: Resolver;
}

// Statuses whose Response must have a null body (the constructor throws
// otherwise).
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

function guardedLookup(resolve: Resolver, isBlocked: (ip: string) => boolean) {
  return (
    hostname: string,
    options: { family?: number | string; all?: boolean },
    callback: LookupCallback
  ): void => {
    resolve(hostname)
      .then((answers) => {
        if (answers.length === 0) {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: 'ENOTFOUND',
          });
        }
        // Any blocked answer refuses the whole name: with several
        // addresses, net may try each in turn (happy eyeballs).
        if (answers.some((a) => isBlocked(a.address))) {
          throw new UnsafeUrlError('Refusing non-public address');
        }
        const family = Number(options.family) || 0;
        const usable =
          family === 4 || family === 6
            ? answers.filter((a) => a.family === family)
            : answers;
        if (usable.length === 0) {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: 'ENOTFOUND',
          });
        }
        if (options.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, ''));
  };
}

/**
 * The stream that undoes a response's Content-Encoding, null for
 * identity. Anything else is refused: forwarding bytes we cannot read
 * would mislabel them.
 */
function decoderFor(header: string | null): Transform | null {
  const encoding = (header ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return null;
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip();
  if (encoding === 'deflate') return zlib.createInflate();
  if (encoding === 'br') return zlib.createBrotliDecompress();
  throw new Error(`Unsupported content-encoding: ${encoding}`);
}

function encodeBody(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  throw new TypeError('guardedRequest: unsupported body type');
}

/**
 * A fetch-shaped request that refuses to connect to a blocked address,
 * whether the URL names it literally or a DNS answer does at connect
 * time. Resolves to a real `Response`; throws `UnsafeUrlError` on a
 * refused address and the signal's reason on abort/timeout.
 */
export function guardedRequest(
  rawUrl: string,
  init: RequestInit,
  opts: GuardedRequestOptions
): Promise<Response> {
  const { isBlocked, resolve = defaultResolver } = opts;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.reject(new UnsafeUrlError('Malformed URL'));
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Promise.reject(new UnsafeUrlError(`Refusing ${url.protocol} URL`));
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // `lookup` is skipped for an IP literal, so this is its only check.
  if (isIP(hostname) && isBlocked(hostname)) {
    return Promise.reject(new UnsafeUrlError('Refusing non-public address'));
  }

  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(signal.reason);

  let body: Buffer | undefined;
  try {
    body = encodeBody(init.body);
  } catch (err) {
    return Promise.reject(err);
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  if (body && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.byteLength);
  }

  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<Response>((resolvePromise, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? 'GET').toUpperCase(),
        headers,
        agent: false,
        lookup: guardedLookup(resolve, isBlocked) as never,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const resHeaders = new Headers();
        const raw = res.rawHeaders;
        try {
          for (let i = 0; i + 1 < raw.length; i += 2) {
            resHeaders.append(raw[i], raw[i + 1]);
          }
          const nullBody = NULL_BODY_STATUSES.has(status);
          if (nullBody) res.resume();
          let source: Readable = res;
          if (!nullBody) {
            const decoder = decoderFor(resHeaders.get('content-encoding'));
            if (decoder) {
              source = res.pipe(decoder);
              res.on('error', (e) => decoder.destroy(e));
              resHeaders.delete('content-encoding');
              resHeaders.delete('content-length');
            }
          }
          resolvePromise(
            new Response(
              nullBody ? null : (Readable.toWeb(source) as ReadableStream),
              { status, statusText: res.statusMessage, headers: resHeaders }
            )
          );
        } catch (err) {
          // A status outside 200-599 or an unrepresentable header.
          res.destroy();
          reject(err);
        }
      }
    );
    req.on('error', (err) => {
      reject(signal?.aborted ? signal.reason : err);
    });
    req.end(body);
  });
}
