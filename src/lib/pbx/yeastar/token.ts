import { createHash } from 'node:crypto';
import { YeastarError } from './errors';
import {
  callYeastar,
  resolveConnection,
  type FetchFn,
  type YeastarConnection,
} from './http';

/** What the cache holds. Expiry times are epoch milliseconds. */
export interface CachedTokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

/**
 * Shared token storage. Yeastar allows at most 8 valid access tokens per
 * API application, and a token lives 30 minutes, so tokens cannot be
 * minted per request or per serverless instance: every instance must
 * read the same row, and `withLock` must exclude minting across all of
 * them (the Postgres implementation uses an advisory lock). One cache
 * per credential pair: the Linkus SDK's AccessID/AccessKey need their
 * own.
 */
export interface TokenCache {
  read(): Promise<CachedTokens | null>;
  write(tokens: CachedTokens): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Single-process cache for tests and local development. */
export class MemoryTokenCache implements TokenCache {
  private tokens: CachedTokens | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  async read(): Promise<CachedTokens | null> {
    return this.tokens ? { ...this.tokens } : null;
  }

  async write(tokens: CachedTokens): Promise<void> {
    this.tokens = { ...tokens };
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /**
   * Marks `rejectedToken` unusable so the next `getAccessToken` mints.
   * Conditional on purpose: when a burst of requests all get 10004, only
   * the first may discard the cached token. The rest would otherwise
   * throw away the token the first one just minted, and each re-mint
   * spends one of the application's 8 token slots.
   */
  invalidate(rejectedToken?: string): Promise<void>;
}

export interface YeastarTokenConnection extends YeastarConnection {
  /** Client ID (Integrations > API), or the Linkus SDK AccessID. */
  clientId: string;
  /** Client Secret, or the Linkus SDK AccessKey. */
  clientSecret: string;
}

/** Reuse an access token until 5 minutes before it expires. */
export const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
export const AUTH_BACKOFF_BASE_MS = 60_000;
export const AUTH_BACKOFF_MAX_MS = 15 * 60_000;

interface AuthBackoff {
  failures: number;
  until: number;
  error: YeastarError;
}

/**
 * Keyed by PBX + credentials at module scope, not per manager, so that
 * managers built per request still share it. The secret is part of the
 * key so a corrected secret is tried at once instead of waiting out the
 * old one's backoff.
 */
const authBackoff = new Map<string, AuthBackoff>();

export function createTokenManager(options: {
  connection: YeastarTokenConnection;
  cache: TokenCache;
  fetch?: FetchFn;
  now?: () => number;
}): TokenProvider {
  const { cache } = options;
  const conn = resolveConnection(options.connection);
  const { clientId, clientSecret } = options.connection;
  const fetchImpl: FetchFn =
    options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const backoffKey = createHash('sha256')
    .update(`${conn.baseUrl}\n${clientId}\n${clientSecret}`)
    .digest('hex');

  let memo: CachedTokens | null = null;
  let inflight: Promise<string> | null = null;

  const usable = (t: CachedTokens | null): t is CachedTokens =>
    t !== null && t.accessTokenExpiresAt - TOKEN_REUSE_MARGIN_MS > now();

  function throwIfBackingOff(): void {
    const state = authBackoff.get(backoffKey);
    if (state && now() < state.until) throw state.error;
  }

  function recordRejection(error: YeastarError): void {
    const failures = (authBackoff.get(backoffKey)?.failures ?? 0) + 1;
    const wait = Math.min(
      AUTH_BACKOFF_BASE_MS * 2 ** (failures - 1),
      AUTH_BACKOFF_MAX_MS
    );
    authBackoff.set(backoffKey, { failures, until: now() + wait, error });
  }

  async function exchange(
    endpoint: 'get_token' | 'refresh_token',
    body: Record<string, string>
  ): Promise<CachedTokens> {
    // Taken before sending: the PBX starts the lifetime after it
    // receives the request, so this errs on the early side.
    const issuedAt = now();
    const res = await callYeastar(conn, fetchImpl, 'POST', endpoint, { body });
    const accessToken = res.access_token;
    const accessTtl = res.access_token_expire_time;
    const refreshToken = res.refresh_token;
    const refreshTtl = res.refresh_token_expire_time;
    if (
      typeof accessToken !== 'string' ||
      !accessToken ||
      typeof accessTtl !== 'number' ||
      typeof refreshToken !== 'string' ||
      typeof refreshTtl !== 'number'
    ) {
      throw new YeastarError({
        endpoint,
        errcode: null,
        errmsg: 'INVALID RESPONSE',
        detail: 'token fields missing',
      });
    }
    return {
      accessToken,
      accessTokenExpiresAt: issuedAt + accessTtl * 1000,
      refreshToken,
      refreshTokenExpiresAt: issuedAt + refreshTtl * 1000,
    };
  }

  async function mint(current: CachedTokens | null): Promise<CachedTokens> {
    if (
      current?.refreshToken &&
      current.refreshTokenExpiresAt - TOKEN_REUSE_MARGIN_MS > now()
    ) {
      try {
        // The response rotates the refresh token too; the caller stores both.
        return await exchange('refresh_token', {
          refresh_token: current.refreshToken,
        });
      } catch (err) {
        // A refresh token the PBX no longer honours falls back to
        // get_token. A transport failure does not: get_token would only
        // hit the same wall and double the wait.
        if (!(err instanceof YeastarError) || err.errcode === null) throw err;
      }
    }
    try {
      const minted = await exchange('get_token', {
        username: clientId,
        password: clientSecret,
      });
      authBackoff.delete(backoffKey);
      return minted;
    } catch (err) {
      // Any answer from the PBX (bad credentials, IP blocked, API off,
      // token cap) holds every caller off: five consecutive auth failures
      // get this server's IP blocked, and none of these clear in seconds.
      if (err instanceof YeastarError && err.errcode !== null) {
        recordRejection(err);
      }
      throw err;
    }
  }

  async function mintUnderLock(): Promise<string> {
    throwIfBackingOff();
    return cache.withLock(async () => {
      // Another instance may have minted while we waited for the lock.
      const current = await cache.read();
      if (usable(current)) {
        memo = current;
        return current.accessToken;
      }
      throwIfBackingOff();
      const minted = await mint(current);
      await cache.write(minted);
      memo = minted;
      return minted.accessToken;
    });
  }

  return {
    async getAccessToken() {
      if (usable(memo)) return memo.accessToken;
      const cached = await cache.read();
      if (usable(cached)) {
        memo = cached;
        return cached.accessToken;
      }
      // One mint per process at a time; the cache lock covers the rest.
      inflight ??= mintUnderLock().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async invalidate(rejectedToken) {
      if (rejectedToken === undefined || memo?.accessToken === rejectedToken) {
        memo = null;
      }
      await cache.withLock(async () => {
        const current = await cache.read();
        if (!current || current.accessTokenExpiresAt === 0) return;
        if (
          rejectedToken !== undefined &&
          current.accessToken !== rejectedToken
        ) {
          return;
        }
        // Keep the refresh token: the next mint can use it.
        await cache.write({ ...current, accessTokenExpiresAt: 0 });
      });
    },
  };
}
