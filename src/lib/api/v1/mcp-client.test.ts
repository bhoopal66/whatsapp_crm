// The MCP server is its own package and the root scripts never test it;
// its HTTP client imports nothing from there at run time.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaamulClient } from '../../../../mcp-server/src/client';

const client = new TaamulClient({ baseUrl: 'http://crm', apiKey: 'k' });
const fetchMock = vi.fn();
const answer = (body: string | null, init?: ResponseInit) =>
  fetchMock.mockResolvedValue(new Response(body, init));
const timeout = () => new DOMException('timed out', 'TimeoutError');
const send = () => client.sendMessage({}).catch((e: unknown) => e);
const get = () => client.me().catch((e: unknown) => e);

vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

describe('the MCP client', () => {
  it('gives up after 30 seconds', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    answer('{"data":1}');
    expect(await client.me()).toEqual({ data: 1, meta: undefined });
    expect(spy).toHaveBeenCalledWith(30_000);
    expect(fetchMock.mock.calls[0][1].signal).toBe(spy.mock.results[0].value);
  });

  it('says a write that timed out may have gone through', async () => {
    fetchMock.mockRejectedValue(timeout());
    expect(await send()).toMatchObject({
      name: 'TaamulApiError',
      code: 'timeout',
      message: expect.stringContaining('may have gone through'),
    });
    expect(((await get()) as Error).message).not.toContain('gone through');
  });

  it('covers a timeout while the body is read', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.reject(timeout()),
    });
    expect(await send()).toMatchObject({ code: 'timeout' });
  });

  it.each(['<html>', '{}', 'null', ''])(
    'never takes a 2xx with the body %j for an answer',
    async (body) => {
      answer(body, { status: 200 });
      expect(await send()).toMatchObject({
        name: 'TaamulApiError',
        status: 200,
        code: 'bad_response',
        message: expect.stringContaining('may have gone through'),
      });
    }
  );

  const dropped = (code?: string) =>
    Object.assign(new TypeError('fetch failed'), { cause: { code } });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', undefined])(
    'says a write whose connection dropped (%s) may have gone through',
    async (code) => {
      fetchMock.mockRejectedValue(dropped(code));
      expect(await send()).toMatchObject({
        name: 'TaamulApiError',
        code: 'network_error',
        message: expect.stringContaining('may have gone through'),
      });
      expect(((await get()) as Error).message).not.toContain('gone through');
    }
  );

  it.each(['ECONNREFUSED', 'ENOTFOUND'])(
    'a write that never connected (%s) did not go through',
    async (code) => {
      fetchMock.mockRejectedValue(dropped(code));
      expect(await send()).toMatchObject({
        code: 'network_error',
        message: 'Could not reach Taamul Connect at http://crm: fetch failed',
      });
    }
  );

  it.each([
    [502, '<html>Bad gateway</html>'],
    [504, '<html>Timed out</html>'],
    [502, ''],
  ])(
    'says a write a proxy answered %i %j may have gone through',
    async (status, body) => {
      const reply = () =>
        fetchMock.mockResolvedValue(new Response(body, { status }));
      reply();
      const message = expect.stringContaining('may have gone through');
      expect(await send()).toMatchObject({ status, code: 'internal', message });
      reply();
      expect(await get()).toMatchObject({
        status,
        message: body || `Request failed with status ${status}`,
      });
    }
  );

  it.each([
    [500, '{"error":{"code":"internal","message":"Failed"}}', 'Failed'],
    [413, '<html>Too large</html>', '<html>Too large</html>'],
  ])(
    'a write refused with %i %s is just that',
    async (status, body, message) => {
      answer(body, { status });
      expect(await send()).toMatchObject({ status, message });
    }
  );

  it.each([429, 503])('passes on Retry-After for a %i', async (status) => {
    answer('{"error":{"code":"x","message":"Wait"}}', {
      status,
      headers: { 'Retry-After': '5' },
    });
    expect(await send()).toMatchObject({
      status,
      message: 'Wait (retry after 5s)',
    });
  });
});
