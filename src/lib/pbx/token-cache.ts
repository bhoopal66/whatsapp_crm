import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import type { CachedTokens, TokenCache } from './yeastar';

/** 'api' = the API application; 'sdk' = the Linkus SDK AccessID/AccessKey. */
export type PbxTokenKind = 'api' | 'sdk';

const COLUMNS = {
  api: { enc: 'token_cache_enc', stamp: 'token_cache_updated_at' },
  sdk: { enc: 'sdk_token_cache_enc', stamp: 'sdk_token_cache_updated_at' },
} as const;

/** A lost compare-and-set re-runs the locked function at most this often. */
export const MAX_SWAP_ATTEMPTS = 3;

interface Snapshot {
  tokens: CachedTokens | null;
  /** `*_updated_at` exactly as read; NULL = never written. */
  stamp: string | null;
}

interface Session {
  key: string;
  snapshot: Snapshot;
  pending: CachedTokens | null;
}

// Module scope, so caches built per request still share one queue per
// (connection, kind) within this process.
const queues = new Map<string, Promise<unknown>>();
const sessions = new AsyncLocalStorage<Session>();

function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function isCachedTokens(v: unknown): v is CachedTokens {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.accessToken === 'string' &&
    typeof t.accessTokenExpiresAt === 'number' &&
    typeof t.refreshToken === 'string' &&
    typeof t.refreshTokenExpiresAt === 'number'
  );
}

/** An unreadable cache (a rotated key, a corrupt row) is an empty one. */
export function openCachedTokens(enc: string | null): CachedTokens | null {
  if (!enc) return null;
  try {
    const parsed: unknown = JSON.parse(decrypt(enc));
    return isCachedTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The shared Yeastar token cache: one encrypted JSON value per
 * connection and credential pair in `pbx_connection_secrets` (service
 * role only, so `db` must be the service-role client).
 *
 * `withLock` is an in-process queue per (connection, kind) plus an
 * optimistic compare-and-set across processes: it reads the cache and
 * its `*_updated_at` stamp, runs `fn` over that snapshot (`read` returns
 * it and `write` only records the new value), then writes through
 * `pbx_token_swap`, which succeeds only if the stamp is unchanged. The
 * advisory lock (`pbx_token_lock`) is not used: through PostgREST it
 * would end with its own one-call transaction, before `fn` runs.
 *
 * A lost swap means another process stored tokens first. `fn` runs again
 * over the winner's tokens, so the token manager returns the winner's
 * token and every process converges on the one row; the loser's token
 * is simply abandoned. A lost race therefore wastes one token, which
 * Yeastar's cap of 8 live tokens per application tolerates (each lives
 * 30 minutes). After `MAX_SWAP_ATTEMPTS` losses it throws rather than
 * keep an unshared token.
 */
export function createDbTokenCache(
  db: SupabaseClient,
  connectionId: string,
  kind: PbxTokenKind
): TokenCache {
  const cols = COLUMNS[kind];
  const key = `${connectionId}:${kind}`;
  const current = (): Session | undefined => {
    const s = sessions.getStore();
    return s?.key === key ? s : undefined;
  };

  async function load(): Promise<Snapshot> {
    const { data, error } = await db
      .from('pbx_connection_secrets')
      .select(`${cols.enc}, ${cols.stamp}`)
      .eq('connection_id', connectionId)
      .maybeSingle();
    if (error) throw new Error(`PBX token cache read failed: ${error.message}`);
    if (!data) {
      throw new Error(`PBX connection ${connectionId} has no secrets row`);
    }
    const row = data as Record<string, string | null>;
    return {
      tokens: openCachedTokens(row[cols.enc] ?? null),
      stamp: row[cols.stamp] ?? null,
    };
  }

  async function swap(
    expected: string | null,
    tokens: CachedTokens
  ): Promise<boolean> {
    const { data, error } = await db.rpc('pbx_token_swap', {
      p_connection_id: connectionId,
      p_expected_updated_at: expected,
      p_new_enc: encrypt(JSON.stringify(tokens)),
      p_kind: kind,
    });
    if (error) {
      throw new Error(`PBX token cache write failed: ${error.message}`);
    }
    return data === true;
  }

  const cache: TokenCache = {
    async read() {
      const session = current();
      const tokens = session
        ? (session.pending ?? session.snapshot.tokens)
        : (await load()).tokens;
      return tokens ? { ...tokens } : null;
    },

    async write(tokens) {
      const session = current();
      if (session) {
        session.pending = { ...tokens };
        return;
      }
      await cache.withLock(() => cache.write(tokens));
    },

    withLock<T>(fn: () => Promise<T>): Promise<T> {
      return runExclusive(key, async () => {
        for (let attempt = 1; ; attempt++) {
          const session: Session = {
            key,
            snapshot: await load(),
            pending: null,
          };
          const result = await sessions.run(session, fn);
          if (!session.pending) return result;
          if (await swap(session.snapshot.stamp, session.pending)) {
            return result;
          }
          if (attempt >= MAX_SWAP_ATTEMPTS) {
            throw new Error(
              `PBX token cache: lost the compare-and-set ${attempt} times`
            );
          }
        }
      });
    },
  };
  return cache;
}
