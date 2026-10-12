/**
 * Sliding-window rate limiter (sliding log) with per-scope limits and a
 * per-scope failure policy: webhook scopes fail open, admin scopes fail
 * closed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { consoleLogger, type EdgeLogger } from './logger';
import { callEdgeRpc, callerNow, firstRow, type RpcClockOptions } from './rpc';

export type ScopeConfig = {
  limit: number;
  windowMs: number;
  failOpen: boolean;
};

export const DEFAULT_SCOPES = {
  'webhook.number': { limit: 4, windowMs: 1000, failOpen: true },
  'webhook.ip': { limit: 600, windowMs: 1000, failOpen: true },
  'admin.ip': { limit: 10, windowMs: 1000, failOpen: false },
  'admin.user': { limit: 30, windowMs: 1000, failOpen: false },
} as const satisfies Record<string, ScopeConfig>;

export type RateDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  degraded?: true;
};
export type StoreResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

export interface RateStore {
  /** Prune the window, count, and record the hit only if allowed — atomically per (scope, key). */
  hit(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    now: number | undefined
  ): Promise<StoreResult>;
}

export class RateLimiter {
  constructor(
    private readonly store: RateStore,
    private readonly scopes: Record<string, ScopeConfig> = DEFAULT_SCOPES,
    private readonly log: EdgeLogger = consoleLogger
  ) {}

  /** `now` (epoch ms) is optional: the RPC store uses the database clock when it is omitted. */
  async check(scope: string, key: string, now?: number): Promise<RateDecision> {
    const cfg = this.scopes[scope];
    if (!cfg) throw new Error(`rate limit scope not configured: ${scope}`);
    try {
      return await this.store.hit(scope, key, cfg.limit, cfg.windowMs, now);
    } catch (err) {
      this.log.warn(
        `rate-limit store failed; failing ${cfg.failOpen ? 'open' : 'closed'}`,
        { scope, key, err: String(err) }
      );
      return cfg.failOpen
        ? { allowed: true, remaining: 0, retryAfterMs: 0, degraded: true }
        : {
            allowed: false,
            remaining: 0,
            retryAfterMs: cfg.windowMs,
            degraded: true,
          };
    }
  }
}

export class MemoryRateStore implements RateStore {
  private readonly logs = new Map<string, number[]>();

  async hit(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now()
  ): Promise<StoreResult> {
    const id = `${scope}\u0000${key}`;
    const log = this.logs.get(id) ?? [];
    while (log.length > 0 && log[0] <= now - windowMs) log.shift();
    if (log.length >= limit) {
      this.logs.set(id, log);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: log[0] + windowMs - now,
      };
    }
    log.push(now);
    this.logs.set(id, log);
    return { allowed: true, remaining: limit - log.length, retryAfterMs: 0 };
  }

  /** Entries currently held for (scope, key) — exposed for tests. */
  size(scope: string, key: string): number {
    return this.logs.get(`${scope}\u0000${key}`)?.length ?? 0;
  }
}

/**
 * One `edge_rate_check` call per hit, so every app instance shares the
 * same window. The database clock is used unless built with
 * `useCallerClock` (tests replaying fixed times).
 */
export class RpcRateStore implements RateStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly opts: RpcClockOptions = {}
  ) {}

  async hit(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    now?: number
  ): Promise<StoreResult> {
    const data = await callEdgeRpc(this.client, 'edge_rate_check', {
      p_scope: scope,
      p_key: key,
      p_limit: limit,
      p_window_ms: windowMs,
      ...callerNow(this.opts.useCallerClock, now),
    });
    const row = firstRow('edge_rate_check', data);
    const { allowed, remaining, retry_after_ms } = row;
    if (
      typeof allowed !== 'boolean' ||
      typeof remaining !== 'number' ||
      typeof retry_after_ms !== 'number'
    ) {
      throw new Error('edge_rate_check returned a malformed row');
    }
    return { allowed, remaining, retryAfterMs: retry_after_ms };
  }
}
