import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeTracks,
  createSession,
  getSession,
  isMeetingsConfigured,
  newTracks,
  renegotiate,
  SfuError,
} from './sfu';

const SECRET = 'cf-secret-value';
const fetchMock = vi.fn();

function answer(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
  });
}

beforeEach(() => {
  vi.stubEnv('CLOUDFLARE_CALLS_APP_ID', 'app-1');
  vi.stubEnv('CLOUDFLARE_CALLS_APP_SECRET', SECRET);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isMeetingsConfigured', () => {
  it('needs both env vars', () => {
    expect(isMeetingsConfigured()).toBe(true);
    vi.stubEnv('CLOUDFLARE_CALLS_APP_SECRET', '');
    expect(isMeetingsConfigured()).toBe(false);
  });
});

describe('Cloudflare Realtime SFU client', () => {
  it('creates a session with the bearer secret and a timeout', async () => {
    fetchMock.mockResolvedValue(answer(201, { sessionId: 'sess-1' }));
    await expect(createSession()).resolves.toEqual({ sessionId: 'sess-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/new'
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('addresses tracks/new, renegotiate, tracks/close and the session', async () => {
    fetchMock.mockImplementation(async () => answer(200, {}));
    const sdp = { type: 'answer' as const, sdp: 'v=0' };
    await newTracks('s/1', { tracks: [] });
    await renegotiate('s/1', sdp);
    await closeTracks('s/1', { tracks: [{ mid: '0' }], force: false });
    await getSession('s/1');
    const calls = fetchMock.mock.calls.map(([u, i]) => [
      i.method,
      String(u).replace('https://rtc.live.cloudflare.com/v1/apps/app-1/', ''),
    ]);
    expect(calls).toEqual([
      ['POST', 'sessions/s%2F1/tracks/new'],
      ['PUT', 'sessions/s%2F1/renegotiate'],
      ['PUT', 'sessions/s%2F1/tracks/close'],
      ['GET', 'sessions/s%2F1'],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      sessionDescription: sdp,
    });
  });

  it('turns a non-2xx into an SfuError with status and code', async () => {
    fetchMock.mockResolvedValue(answer(401, { errorCode: 'unauthorized' }));
    const err = await createSession().catch((e) => e);
    expect(err).toBeInstanceOf(SfuError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(String(err.message)).not.toContain(SECRET);
  });

  it('treats an errorCode inside a 2xx as a refusal', async () => {
    fetchMock.mockResolvedValue(
      answer(200, { errorCode: 'bad_sdp', errorDescription: 'x' })
    );
    await expect(newTracks('s', { tracks: [] })).rejects.toMatchObject({
      status: 502,
      code: 'bad_sdp',
    });
  });

  it('maps a timeout to 504 and a network failure to 502', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('t'), { name: 'TimeoutError' })
    );
    const timeout = await createSession().catch((e) => e);
    expect(timeout).toMatchObject({ status: 504, code: 'timeout' });
    expect(timeout.isTimeout).toBe(true);

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(createSession()).rejects.toMatchObject({
      status: 502,
      code: 'network',
    });
  });

  it('refuses a session answer without an id', async () => {
    fetchMock.mockResolvedValue(answer(201, {}));
    await expect(createSession()).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('never calls out when unconfigured', async () => {
    vi.stubEnv('CLOUDFLARE_CALLS_APP_ID', '');
    await expect(createSession()).rejects.toMatchObject({
      status: 503,
      code: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
