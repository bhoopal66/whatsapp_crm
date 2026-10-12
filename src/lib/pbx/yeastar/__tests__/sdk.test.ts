import { describe, it, expect } from 'vitest';
import { createYeastarClient } from '../client';
import { createSdkSignature } from '../sdk';
import { BASE, endpointOf, fakeFetch, stubTokens } from './fixtures';

// The docs' response example (an object, although the table says array).
const SIGN_OBJECT = {
  errcode: 0,
  errmsg: 'SUCCESS',
  data: { sign: 'ueb3rfcpsiS8FxFUZMpZAO86mbrKmVn3kf0Q9R8' },
};

function setup(reply: object) {
  const f = fakeFetch(() => reply);
  const sdkTokens = stubTokens('sdk-token');
  const client = createYeastarClient({
    connection: { baseUrl: BASE },
    tokens: stubTokens('api-token'),
    fetch: f.fetch,
  });
  const sign = (extra: { expireTime?: number } = {}) =>
    createSdkSignature({
      client,
      sdkTokens,
      username: 'leo@sample.com',
      ...extra,
    });
  return { ...f, sign };
}

describe('createSdkSignature', () => {
  it('POSTs sign/create as the SDK application and returns the signature (object data)', async () => {
    const { sign, calls } = setup(SIGN_OBJECT);
    await expect(sign({ expireTime: 0 })).resolves.toBe(
      'ueb3rfcpsiS8FxFUZMpZAO86mbrKmVn3kf0Q9R8'
    );
    expect(calls).toHaveLength(1);
    expect(endpointOf(calls[0])).toBe('sign/create');
    expect(calls[0].method).toBe('POST');
    // The SDK's own token, not the API application's.
    expect(calls[0].url.searchParams.get('access_token')).toBe('sdk-token');
    expect(calls[0].body).toEqual({
      username: 'leo@sample.com',
      sign_type: 'sdk',
      expire_time: 0,
    });
  });

  it('accepts array data, as the table documents it', async () => {
    const { sign } = setup({
      errcode: 0,
      errmsg: 'SUCCESS',
      data: [{ sign: 'first' }, { sign: 'second' }],
    });
    await expect(sign()).resolves.toBe('first');
  });

  it('omits expire_time unless the caller provides it', async () => {
    const { sign, calls } = setup(SIGN_OBJECT);
    await sign();
    await sign({ expireTime: 3600 });
    expect(calls[0].body).toEqual({
      username: 'leo@sample.com',
      sign_type: 'sdk',
    });
    expect(calls[0].body).not.toHaveProperty('expire_time');
    expect(calls[1].body).toMatchObject({ expire_time: 3600 });
  });

  it('a success without a signature is an invalid response', async () => {
    for (const data of [undefined, [], {}, { sign: '' }]) {
      const { sign } = setup({ errcode: 0, errmsg: 'SUCCESS', data });
      await expect(sign()).rejects.toMatchObject({
        errcode: null,
        errmsg: 'INVALID RESPONSE',
        endpoint: 'sign/create',
      });
    }
  });

  it('a PBX failure surfaces as YeastarError', async () => {
    const { sign } = setup({ errcode: 70123, errmsg: 'API UNAVAILABLE' });
    await expect(sign()).rejects.toMatchObject({
      name: 'YeastarError',
      isFeatureDisabled: true,
    });
  });
});
