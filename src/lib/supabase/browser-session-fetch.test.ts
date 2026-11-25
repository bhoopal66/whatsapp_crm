import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrowserSessionFetch } from './session-fetch';

// The real auth-js on a PC whose clock is `SLOW` minutes behind.
const SLOW = 10 * 60;
const SERVER_NOW = 1_800_000_000;
const jwt = (n: number) =>
  ['{"alg":"HS256"}', `{"sub":"u","n":${n}}`, 'sig']
    .map((p) => Buffer.from(p).toString('base64url'))
    .join('.');

let serverNow = SERVER_NOW;
let issued = 0;
let validUntil = 0;
const restTokens: string[] = [];
const grants: string[] = [];

function token() {
  issued += 1;
  validUntil = serverNow + 3600;
  return {
    access_token: jwt(issued),
    refresh_token: `r${issued}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: validUntil,
    user: { id: 'u', aud: 'authenticated' },
  };
}

const server = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/auth/v1/token')) {
    grants.push(url.searchParams.get('grant_type') ?? '');
    return Response.json(token());
  }
  const sent =
    new Headers(init?.headers).get('authorization')?.slice('Bearer '.length) ??
    '';
  restTokens.push(sent);
  if (sent !== jwt(issued) || serverNow >= validUntil) {
    return Response.json(
      { code: 'PGRST303', message: 'JWT expired' },
      { status: 401 }
    );
  }
  return Response.json([{ id: 1 }]);
});

const at = (server: number) => {
  serverNow = server;
  vi.setSystemTime((server - SLOW) * 1000);
};

function make() {
  const store = new Map<string, string>();
  const client: SupabaseClient = createClient('http://sb.test', 'anon', {
    auth: {
      autoRefreshToken: false,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    },
    global: { fetch: createBrowserSessionFetch(() => client) },
  });
  return { client, store };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('fetch', server);
  issued = 0;
  restTokens.length = 0;
  grants.length = 0;
  at(SERVER_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a PC whose clock runs slow', () => {
  it('renews its token before the server refuses it', async () => {
    const { client } = make();
    await client.auth.signInWithPassword({ email: 'a@b.c', password: 'x' });
    at(SERVER_NOW + 3600 - 30);
    const { data, error } = await client.from('contacts').select();
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1 }]);
    expect(grants).toEqual(['password', 'refresh_token']);
    expect(restTokens).toEqual([jwt(2)]);
  });

  it('also in a browser without Response.json (Safari 16)', async () => {
    const real = Response.json;
    const { client } = make();
    const answered = token();
    issued = 0;
    server.mockImplementationOnce(async () => {
      const res = real.call(Response, { ...answered });
      // From here on the browser's own code runs.
      (Response as { json?: unknown }).json = undefined;
      return res;
    });
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: 'a@b.c',
        password: 'x',
      });
      expect(error).toBeNull();
      expect(data.session?.expires_at).toBe(SERVER_NOW - SLOW + 3600);
    } finally {
      (Response as { json?: unknown }).json = real;
    }
  });

  it('sends a refused request once more with a renewed token', async () => {
    const { client, store } = make();
    await client.auth.signInWithPassword({ email: 'a@b.c', password: 'x' });
    // What the server side writes: its own expires_at.
    const [key, value] = [...store][0]!;
    store.set(
      key,
      JSON.stringify({ ...JSON.parse(value), expires_at: validUntil })
    );
    at(SERVER_NOW + 3600 + 60);
    const answers = await Promise.all(
      ['a', 'b', 'c'].map((t) => client.from(t).select())
    );
    for (const { data, error } of answers) {
      expect(error).toBeNull();
      expect(data).toEqual([{ id: 1 }]);
    }
    expect(grants).toEqual(['password', 'refresh_token']);
  });

  it('a renewal that fails leaves the refusal as it was, asked once', async () => {
    const { client, store } = make();
    await client.auth.signInWithPassword({ email: 'a@b.c', password: 'x' });
    const [key, value] = [...store][0]!;
    store.set(
      key,
      JSON.stringify({ ...JSON.parse(value), expires_at: validUntil })
    );
    at(SERVER_NOW + 3600 + 60);
    server.mockImplementationOnce(async () =>
      Response.json(
        { code: 'PGRST303', message: 'JWT expired' },
        { status: 401 }
      )
    );
    server.mockImplementationOnce(async () =>
      Response.json(
        { error_code: 'over_request_rate_limit', msg: 'x' },
        { status: 400 }
      )
    );
    const calls = server.mock.calls.length;
    const { error } = await client.from('contacts').select();
    expect(error?.code).toBe('PGRST303');
    expect(server.mock.calls.length - calls).toBe(2);
  });

  it('other refusals pass untouched', async () => {
    const { client } = make();
    await client.auth.signInWithPassword({ email: 'a@b.c', password: 'x' });
    server.mockImplementationOnce(async () =>
      Response.json(
        { code: '42501', message: 'permission denied' },
        { status: 403 }
      )
    );
    const { error } = await client.from('contacts').select();
    expect(error?.code).toBe('42501');
    expect(grants).toEqual(['password']);
  });
});

it('a clock running fast keeps the server time', async () => {
  const { client, store } = make();
  vi.setSystemTime((SERVER_NOW + 300) * 1000);
  await client.auth.signInWithPassword({ email: 'a@b.c', password: 'x' });
  expect(JSON.parse([...store.values()][0]!).expires_at).toBe(validUntil);
});
