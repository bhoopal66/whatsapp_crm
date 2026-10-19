/**
 * Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (src/assist/rate.ts), moved from
 * node-postgres to supabase-js RPC on the service-role client (migration 120). "workspace" means the wacrm account id.
 *
 * RateLimiter: sliding-window limits in Postgres (public.assist_rate_events), atomic and fail-closed.
 *   key        namespace:subject, e.g. 'assistant:user:<uuid>', 'assistant:workspace:<account uuid>' (validated here and
 *              in SQL). check() refuses a user or account id that is not a uuid with a TypeError before any call.
 *   take       ONE call to public.assist_rate_take: per-key advisory locks, count-in-window, insert only if every key is
 *              under its limit. A refused attempt is not recorded and returns retryAfterMs.
 *   errors     any database error denies with RATE_STATE_UNAVAILABLE (fail closed), logged through the injected logger.
 *   reset      per key only, through the audited admin function public.assist_rate_reset. No global clear exists.
 *              service_role has no EXECUTE on it: resetKey needs a RateLimiter built on an owner / admin connection.
 *   prune      removes rows older than two of their own windows (public.assist_rate_prune).
 * Defaults: per user 30 / minute, per workspace 300 / minute.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { consoleLogger, type EdgeLogger } from '@/lib/edge/logger';

export interface RateRule {
  readonly limit: number;
  readonly windowMs: number;
}
export interface RateLimits {
  readonly user: RateRule;
  readonly workspace: RateRule;
}
export const DEFAULT_RATE_LIMITS: RateLimits = {
  user: { limit: 30, windowMs: 60_000 },
  workspace: { limit: 300, windowMs: 60_000 },
};
export const RATE_NAMESPACE = 'assistant';

export type RateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'RATE_LIMITED';
      key: string;
      retryAfterMs: number;
    }
  | { allowed: false; reason: 'RATE_STATE_UNAVAILABLE' };

const KEY = /^[a-z][a-z0-9_]*:.+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const rateKey = (namespace: string, ...subject: string[]): string => {
  const k = [namespace, ...subject].join(':');
  if (!KEY.test(k) || subject.length === 0 || subject.some((s) => s === ''))
    throw new TypeError(`rateKey: '${k}' is not namespace:subject`);
  return k;
};

type TakeRow = {
  allowed: boolean;
  denied_key: string | null;
  retry_after_ms: string | number;
};

export class RateLimiter {
  readonly limits: RateLimits;
  private readonly namespace: string;
  private readonly logger: EdgeLogger;

  constructor(
    private readonly db: SupabaseClient,
    opts: {
      limits?: Partial<RateLimits>;
      namespace?: string;
      logger?: EdgeLogger;
    } = {}
  ) {
    this.limits = { ...DEFAULT_RATE_LIMITS, ...opts.limits };
    this.namespace = opts.namespace ?? RATE_NAMESPACE;
    this.logger = opts.logger ?? consoleLogger;
    for (const r of [this.limits.user, this.limits.workspace]) {
      if (
        !Number.isInteger(r.limit) ||
        r.limit < 0 ||
        !Number.isInteger(r.windowMs) ||
        r.windowMs <= 0
      )
        throw new TypeError('RateLimiter: bad limit');
    }
  }

  /** Takes one slot on the user key and the workspace key together (both or neither). */
  check(scope: { userId: string; workspaceId: string }): Promise<RateDecision> {
    if (!UUID.test(scope.userId) || !UUID.test(scope.workspaceId))
      throw new TypeError('RateLimiter.check: user and account ids are uuids');
    return this.takeMany([
      {
        key: rateKey(this.namespace, 'user', scope.userId.toLowerCase()),
        ...this.limits.user,
      },
      {
        key: rateKey(
          this.namespace,
          'workspace',
          scope.workspaceId.toLowerCase()
        ),
        ...this.limits.workspace,
      },
    ]);
  }

  take(key: string, rule: RateRule): Promise<RateDecision> {
    return this.takeMany([{ key, ...rule }]);
  }

  async takeMany(
    items: ReadonlyArray<{ key: string; limit: number; windowMs: number }>
  ): Promise<RateDecision> {
    for (const i of items)
      if (!KEY.test(i.key))
        throw new TypeError(`RateLimiter: '${i.key}' is not namespace:subject`);
    try {
      const { data, error } = await this.db.rpc('assist_rate_take', {
        p_keys: items.map((i) => i.key),
        p_limits: items.map((i) => i.limit),
        p_windows_ms: items.map((i) => i.windowMs),
      });
      if (error) {
        this.logger.warn('assist_rate_take failed', {
          code: error.code,
        });
        return { allowed: false, reason: 'RATE_STATE_UNAVAILABLE' };
      }
      const row = (Array.isArray(data) ? data[0] : undefined) as
        TakeRow | undefined;
      if (!row) return { allowed: false, reason: 'RATE_STATE_UNAVAILABLE' };
      if (row.allowed === true) return { allowed: true };
      return {
        allowed: false,
        reason: 'RATE_LIMITED',
        key: row.denied_key ?? '',
        retryAfterMs: Number(row.retry_after_ms),
      };
    } catch (e) {
      this.logger.warn('assist_rate_take threw', {
        message: e instanceof Error ? e.message : String(e),
      });
      return { allowed: false, reason: 'RATE_STATE_UNAVAILABLE' };
    }
  }

  /**
   * Admin: clears ONE key, audited with actor and reason. Returns the number of events removed. service_role has no
   * EXECUTE on assist_rate_reset: construct this RateLimiter on an owner / admin connection to call it.
   */
  async resetKey(
    key: string,
    admin: { actor: string; reason: string }
  ): Promise<number> {
    if (!KEY.test(key))
      throw new TypeError(
        `RateLimiter.resetKey: '${key}' is not namespace:subject`
      );
    return Number(
      (await this.call('assist_rate_reset', {
        p_key: key,
        p_actor: admin.actor,
        p_reason: admin.reason,
      })) ?? 0
    );
  }

  /** Deletes events older than two of their own windows. */
  async prune(): Promise<number> {
    return Number((await this.call('assist_rate_prune', {})) ?? 0);
  }

  private async call(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    // Function name and SQLSTATE only: PostgREST's message can carry row data.
    if (error)
      throw new Error(
        error.code ? `${fn} failed (${error.code})` : `${fn} failed`
      );
    return data as unknown;
  }
}
