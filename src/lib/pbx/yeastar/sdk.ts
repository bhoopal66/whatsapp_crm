import { YeastarError } from './errors';
import type { YeastarClient } from './client';
import type { TokenProvider } from './token';

/**
 * A Linkus SDK login signature for one extension user, via
 * `POST sign/create`. It authenticates with the SDK's own AccessID /
 * AccessKey (`sdkTokens`), not the API application's. `username` is the
 * extension user's email address, as the SDK guide specifies.
 *
 * `expireTime` is sent only when given: the docs say "expiration
 * timestamp ... (Unit: second)" with 0 meaning no limit, and do not say
 * whether a non-zero value is absolute or relative.
 *
 * The docs type `data` as an array but their example shows an object;
 * both are accepted.
 */
export async function createSdkSignature(options: {
  client: YeastarClient;
  sdkTokens: TokenProvider;
  username: string;
  expireTime?: number;
}): Promise<string> {
  const { client, sdkTokens, username, expireTime } = options;
  const body: Record<string, string | number> = {
    username,
    sign_type: 'sdk',
  };
  if (expireTime !== undefined) body.expire_time = expireTime;

  const res = await client.request('POST', 'sign/create', {
    body,
    tokens: sdkTokens,
  });
  const candidates = Array.isArray(res.data) ? res.data : [res.data];
  for (const c of candidates) {
    const sign =
      typeof c === 'object' && c !== null
        ? (c as { sign?: unknown }).sign
        : undefined;
    if (typeof sign === 'string' && sign !== '') return sign;
  }
  throw new YeastarError({
    endpoint: 'sign/create',
    errcode: null,
    errmsg: 'INVALID RESPONSE',
    detail: 'sign missing',
  });
}
