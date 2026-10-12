import { YeastarError } from './errors';
import {
  callYeastar,
  joinUrl,
  resolveConnection,
  type FetchFn,
  type YeastarConnection,
  type YeastarMethod,
  type YeastarQuery,
} from './http';
import type { TokenProvider } from './token';

export interface YeastarRequestOptions {
  query?: YeastarQuery;
  body?: unknown;
  /** Overrides the client's tokens (the Linkus SDK has its own). */
  tokens?: TokenProvider;
}

export interface YeastarClient {
  /** Resolves to the success body; any `errcode !== 0` throws. */
  request<T extends object = Record<string, unknown>>(
    method: YeastarMethod,
    endpoint: string,
    options?: YeastarRequestOptions
  ): Promise<T>;
  /**
   * `{base}/{resourcePath}?access_token=...` for a resource the PBX hands
   * out by path (recording downloads). The URL embeds a live token:
   * fetch it server-side, never send it to a browser or a log.
   */
  resourceUrl(
    resourcePath: string,
    options?: { tokens?: TokenProvider }
  ): Promise<string>;
}

export function createYeastarClient(options: {
  connection: YeastarConnection;
  tokens: TokenProvider;
  fetch?: FetchFn;
}): YeastarClient {
  const conn = resolveConnection(options.connection);
  const fetchImpl: FetchFn =
    options.fetch ?? ((input, init) => fetch(input, init));

  return {
    async request<T extends object>(
      method: YeastarMethod,
      endpoint: string,
      { query, body, tokens = options.tokens }: YeastarRequestOptions = {}
    ): Promise<T> {
      const send = async (accessToken: string) =>
        (await callYeastar(conn, fetchImpl, method, endpoint, {
          query,
          body,
          accessToken,
        })) as T;

      const token = await tokens.getAccessToken();
      try {
        return await send(token);
      } catch (err) {
        if (!(err instanceof YeastarError) || !err.isTokenExpired) throw err;
        // The PBX expired the token before our clock did (or another
        // client's refresh revoked it). A 10004 is refused before the
        // operation runs, so even a dial is safe to repeat. Exactly once:
        // a PBX that rejects every token must not drive us into its
        // 8-token cap.
        await tokens.invalidate(token);
        return send(await tokens.getAccessToken());
      }
    },

    async resourceUrl(resourcePath, { tokens = options.tokens } = {}) {
      const url = new URL(joinUrl(conn.baseUrl, resourcePath));
      url.searchParams.set('access_token', await tokens.getAccessToken());
      return url.toString();
    },
  };
}
