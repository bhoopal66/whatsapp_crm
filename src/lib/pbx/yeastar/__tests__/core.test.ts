import { describe, it, expect, vi } from 'vitest';
import { YeastarError } from '../errors';
import { createYeastarClient } from '../client';
import {
  MemoryTokenCache,
  createTokenManager,
  type TokenProvider,
} from '../token';

// Verbatim examples from the Yeastar Cloud Edition developer guide.
const GET_TOKEN_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  access_token_expire_time: 1800,
  access_token: 'EXZMpZAO86mbrKm6rFtgeb3rfcpC9uqS',
  refresh_token_expire_time: 86400,
  refresh_token: 'SCduGecwbG9jIusiS8FxFUVn3kf0Q9R8',
};
const REFRESH_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  access_token_expire_time: 1800,
  access_token: '4JkX5GQObeL9MGcPZDN4o4Ecv114Jo1e',
  refresh_token_expire_time: 86400,
  refresh_token: 'fTyEpc1OTDU2vckJauWL6uBRasYYpbKU',
};
const BAD_CREDENTIALS = {
  errcode: -1,
  errmsg: 'FAILURE',
  invalid_param_list: [{ field: 'username or password', value: 'error' }],
};
const DIAL_OK = { errcode: 0, errmsg: 'SUCCESS', call_id: '1650095575.872' };
const TOKEN_EXPIRED = { errcode: 10004, errmsg: 'TOKEN EXPIRED' };

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
type Reply = object | Response | Promise<object | Response>;

function fakeFetch(reply: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = await reply(call);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const endpoint = (c: Call) => c.url.pathname.replace('/openapi/v1.0/', '');
let pbxSeq = 0;
// The auth backoff is module-scoped per PBX + credentials: a fresh host
// per test keeps one test's failures out of the next.
const freshBase = () => `https://pbx${++pbxSeq}.example.yeastarcloud.com`;

function manager(
  fetchImpl: typeof fetch,
  opts: { base?: string; cache?: MemoryTokenCache; now?: () => number } = {}
) {
  return createTokenManager({
    connection: {
      baseUrl: opts.base ?? freshBase(),
      clientId: 'UEnH9Dmv6uBJEXsYcag1trNfQThYXXXX',
      clientSecret: 'ZLcXl63S9EtMnYoHUnjbVo6sA8CbXXXX',
    },
    cache: opts.cache ?? new MemoryTokenCache(),
    fetch: fetchImpl,
    now: opts.now,
  });
}

function stubTokens(...tokens: string[]) {
  let i = 0;
  return {
    getAccessToken: vi.fn(async () => tokens[Math.min(i, tokens.length - 1)]),
    invalidate: vi.fn(async () => {
      i += 1;
    }),
  } satisfies TokenProvider;
}

describe('YeastarError getters', () => {
  const err = (errcode: number, ep = 'call/dial', response = {}) =>
    new YeastarError({ endpoint: ep, errcode, errmsg: 'X', response });
  it('maps errcodes to capabilities', () => {
    expect(err(10004).isTokenExpired).toBe(true);
    expect(err(-1, 'get_token').isAuthFailure).toBe(true);
    expect(err(-1, 'call/dial').isAuthFailure).toBe(false);
    expect(err(-1, 'refresh_token', BAD_CREDENTIALS).isAuthFailure).toBe(true);
    expect([70004, 70087].map((c) => err(c).isIpBlocked)).toEqual([true, true]);
    expect(err(70651).isRecordingDownloadBusy).toBe(true);
    expect(err(70130).isChannelNotFound).toBe(true);
    expect([70123, 70656, 10009].every((c) => err(c).isFeatureDisabled)).toBe(
      true
    );
    expect(err(40002).isFeatureDisabled).toBe(false);
  });
});

describe('createYeastarClient', () => {
  it('builds {base}/{apiPath}/{endpoint}?access_token= with User-Agent and JSON', async () => {
    const f = fakeFetch(() => DIAL_OK);
    const client = createYeastarClient({
      connection: { baseUrl: 'https://yeastardocs.example.yeastarcloud.com/' },
      tokens: stubTokens('4aR4RzkFGEfIvGDJVbAd4vEWg6NtoWog'),
      fetch: f.fetch,
    });
    const res = await client.request('POST', 'call/dial', {
      query: { page: 1, skip: undefined },
      body: { caller: '1005', callee: '5503301' },
    });
    expect(res).toEqual(DIAL_OK);
    const [call] = f.calls;
    expect(call.url.origin + call.url.pathname).toBe(
      'https://yeastardocs.example.yeastarcloud.com/openapi/v1.0/call/dial'
    );
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      page: '1',
      access_token: '4aR4RzkFGEfIvGDJVbAd4vEWg6NtoWog',
    });
    expect(call.headers['User-Agent']).toBe('wacrm');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({ caller: '1005', callee: '5503301' });
  });

  it('throws YeastarError from errcode, even on a non-2xx status', async () => {
    const f = fakeFetch(
      () =>
        new Response(JSON.stringify({ errcode: 70130, errmsg: 'CAHNNEL' }), {
          status: 500,
        })
    );
    const client = createYeastarClient({
      connection: { baseUrl: 'https://pbx.test', userAgent: 'OpenAPI' },
      tokens: stubTokens('t1'),
      fetch: f.fetch,
    });
    const err = await client
      .request('POST', 'call/hangup', { body: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YeastarError);
    expect(err).toMatchObject({
      errcode: 70130,
      httpStatus: 500,
      endpoint: 'call/hangup',
      isChannelNotFound: true,
    });
    expect(f.calls[0].headers['User-Agent']).toBe('OpenAPI');
  });

  it('a body without an envelope or a timeout is errcode null, token redacted', async () => {
    const html = fakeFetch(
      () => new Response('<html>502</html>', { status: 502 })
    );
    const tokens = stubTokens('secret-token');
    const c1 = createYeastarClient({
      connection: { baseUrl: 'https://pbx.test' },
      tokens,
      fetch: html.fetch,
    });
    await expect(c1.request('GET', 'extension/list')).rejects.toMatchObject({
      errcode: null,
      errmsg: 'INVALID RESPONSE',
      httpStatus: 502,
    });

    const slow = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted access_token=secret-token'))
          )
        )
    );
    const c2 = createYeastarClient({
      connection: { baseUrl: 'https://pbx.test', timeoutMs: 20 },
      tokens,
      fetch: slow as unknown as typeof fetch,
    });
    const err = (await c2
      .request('GET', 'extension/list')
      .catch((e: unknown) => e)) as YeastarError;
    expect(err.errmsg).toBe('TIMEOUT');
    expect(err.message).not.toContain('secret-token');
  });

  it('10004 → invalidate that token, retry once with a new one', async () => {
    const f = fakeFetch((c) =>
      c.url.searchParams.get('access_token') === 'old' ? TOKEN_EXPIRED : DIAL_OK
    );
    const tokens = stubTokens('old', 'new');
    const client = createYeastarClient({
      connection: { baseUrl: 'https://pbx.test' },
      tokens,
      fetch: f.fetch,
    });
    await expect(
      client.request('POST', 'call/dial', { body: {} })
    ).resolves.toEqual(DIAL_OK);
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(tokens.invalidate).toHaveBeenCalledWith('old');
    expect(f.calls.map((c) => c.url.searchParams.get('access_token'))).toEqual([
      'old',
      'new',
    ]);
  });

  it('a second 10004 is not retried', async () => {
    const f = fakeFetch(() => TOKEN_EXPIRED);
    const tokens = stubTokens('a', 'b', 'c');
    const client = createYeastarClient({
      connection: { baseUrl: 'https://pbx.test' },
      tokens,
      fetch: f.fetch,
    });
    await expect(client.request('GET', 'call/query')).rejects.toMatchObject({
      isTokenExpired: true,
    });
    expect(f.calls).toHaveLength(2);
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe('createTokenManager', () => {
  const MIN = 60_000;

  it('get_token: no access_token in the URL, credentials in the body', async () => {
    const f = fakeFetch(() => GET_TOKEN_OK);
    const base = freshBase();
    const token = await manager(f.fetch, { base }).getAccessToken();
    expect(token).toBe('EXZMpZAO86mbrKm6rFtgeb3rfcpC9uqS');
    const [call] = f.calls;
    expect(call.url.toString()).toBe(`${base}/openapi/v1.0/get_token`);
    expect(call.method).toBe('POST');
    expect(call.headers['User-Agent']).toBe('wacrm');
    expect(call.body).toEqual({
      username: 'UEnH9Dmv6uBJEXsYcag1trNfQThYXXXX',
      password: 'ZLcXl63S9EtMnYoHUnjbVo6sA8CbXXXX',
    });
  });

  it('reuses until 5 min before expiry, then refreshes with the refresh token', async () => {
    let t = 1_000_000;
    const f = fakeFetch((c) =>
      endpoint(c) === 'get_token' ? GET_TOKEN_OK : REFRESH_OK
    );
    const cache = new MemoryTokenCache();
    const m = manager(f.fetch, { cache, now: () => t });
    await m.getAccessToken();
    t += 25 * MIN - 1;
    expect(await m.getAccessToken()).toBe(GET_TOKEN_OK.access_token);
    expect(f.calls).toHaveLength(1);
    t += 1;
    expect(await m.getAccessToken()).toBe(REFRESH_OK.access_token);
    expect(f.calls.map(endpoint)).toEqual(['get_token', 'refresh_token']);
    expect(f.calls[1].url.searchParams.has('access_token')).toBe(false);
    expect(f.calls[1].body).toEqual({
      refresh_token: GET_TOKEN_OK.refresh_token,
    });
    expect((await cache.read())?.refreshToken).toBe(REFRESH_OK.refresh_token);
  });

  it('uses get_token when the refresh token is expired or rejected', async () => {
    let t = 0;
    let refreshFails = false;
    const f = fakeFetch((c) =>
      endpoint(c) === 'get_token'
        ? GET_TOKEN_OK
        : refreshFails
          ? { errcode: -1, errmsg: 'FAILURE' }
          : REFRESH_OK
    );
    const m = manager(f.fetch, { now: () => t });
    await m.getAccessToken();
    t += 24 * 60 * MIN; // refresh token (24 h) is gone too
    await m.getAccessToken();
    expect(f.calls.map(endpoint)).toEqual(['get_token', 'get_token']);
    t += 26 * MIN;
    refreshFails = true;
    expect(await m.getAccessToken()).toBe(GET_TOKEN_OK.access_token);
    expect(f.calls.map(endpoint).slice(2)).toEqual([
      'refresh_token',
      'get_token',
    ]);
  });

  it('concurrent callers across instances sharing a cache → one mint', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(async () => {
      await gate;
      return GET_TOKEN_OK;
    });
    const cache = new MemoryTokenCache();
    const base = freshBase();
    const instances = [1, 2, 3].map(() => manager(f.fetch, { base, cache }));
    const all = Promise.all(
      instances.flatMap((m) => [m.getAccessToken(), m.getAccessToken()])
    );
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect(new Set(await all)).toEqual(new Set([GET_TOKEN_OK.access_token]));
    expect(f.calls).toHaveLength(1);
  });

  it('auth failure: thrown, not retried, and a burst is held off', async () => {
    let t = 0;
    const f = fakeFetch(() => BAD_CREDENTIALS);
    const base = freshBase();
    const cache = new MemoryTokenCache();
    const burst = [1, 2, 3, 4, 5].map(() =>
      manager(f.fetch, { base, cache, now: () => t })
    );
    const results = await Promise.allSettled(
      burst.map((m) => m.getAccessToken())
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const reason = (results[0] as PromiseRejectedResult).reason as YeastarError;
    expect(reason.isAuthFailure).toBe(true);
    expect(f.calls).toHaveLength(1);

    t += 59_999;
    await expect(burst[0].getAccessToken()).rejects.toMatchObject({
      isAuthFailure: true,
    });
    expect(f.calls).toHaveLength(1);
    t += 1;
    await expect(burst[0].getAccessToken()).rejects.toBeInstanceOf(
      YeastarError
    );
    expect(f.calls).toHaveLength(2);
    t += 60_000; // the second failure doubled the wait
    await expect(burst[1].getAccessToken()).rejects.toBeInstanceOf(
      YeastarError
    );
    expect(f.calls).toHaveLength(2);
  });

  it('invalidate drops only the token that was rejected', async () => {
    const f = fakeFetch((c) =>
      endpoint(c) === 'get_token' ? GET_TOKEN_OK : REFRESH_OK
    );
    const cache = new MemoryTokenCache();
    const m = manager(f.fetch, { cache });
    const first = await m.getAccessToken();
    await m.invalidate(first);
    const second = await m.getAccessToken();
    expect(second).toBe(REFRESH_OK.access_token);
    await m.invalidate(first); // stale report from a slower request
    expect(await m.getAccessToken()).toBe(second);
    expect(f.calls.map(endpoint)).toEqual(['get_token', 'refresh_token']);
  });
});
