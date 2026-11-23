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
