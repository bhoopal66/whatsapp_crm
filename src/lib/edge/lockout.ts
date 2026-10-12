/**
 * Admin auth lockout over a sliding log of failures, keyed by ipKey(ip)
 * and (ip, user): userMax failures for one (ip, user) or ipMax failures
 * from one ip (any users) within windowMs lock that pair / the whole ip
 * for lockMs. A success clears only that pair's failures; they still
 * count toward the ip total. A request without a user id is user "".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ipKey } from './ip';
import { callEdgeRpc, callerNow, firstRow, type RpcClockOptions } from './rpc';

export const LOCKOUT = {
  ipMax: 20,
  userMax: 5,
  windowMs: 10 * 60_000,
  lockMs: 15 * 60_000,
} as const;
export type LockoutConfig = {
  ipMax: number;
  userMax: number;
  windowMs: number;
  lockMs: number;
};

export type LockState = { locked: boolean; retryAfterMs: number };

/** `now` is the caller's clock (epoch ms); the RPC store ignores it unless built with useCallerClock. */
export interface LockoutStore {
  /** Atomically log a failure and apply any lock it trips; returns the resulting state for (ip, user). */
  fail(
    ip: string,
    user: string,
    now: number | undefined,
    cfg: LockoutConfig
  ): Promise<LockState>;
  /** Forget (ip, user)'s failures for the per-user count only. */
  clear(ip: string, user: string): Promise<void>;
  /** Locked if (ip, user) or the whole ip is locked. */
  state(ip: string, user: string, now: number | undefined): Promise<LockState>;
}

export class AuthLockout {
  constructor(
    private readonly store: LockoutStore,
    private readonly cfg: LockoutConfig = LOCKOUT
  ) {}

  /** Returns the resulting lock state (locked on the failure that reaches a limit). */
  recordFailure(ip: string, now?: number, user = ''): Promise<LockState> {
    return this.store.fail(ipKey(ip), user, now, this.cfg);
  }

  recordSuccess(ip: string, user = ''): Promise<void> {
    return this.store.clear(ipKey(ip), user);
  }

  state(ip: string, now?: number, user = ''): Promise<LockState> {
    return this.store.state(ipKey(ip), user, now);
  }

  async isLocked(ip: string, now?: number, user = ''): Promise<boolean> {
    return (await this.state(ip, now, user)).locked;
  }
}

/** Failure log entry; user null = cleared by a success (still counts for the ip). */
type Fail = { user: string | null; at: number };

export class MemoryLockoutStore implements LockoutStore {
  private readonly fails = new Map<string, Fail[]>();
  /** ip → user (null = whole ip) → locked until (epoch ms). */
  private readonly locks = new Map<string, Map<string | null, number>>();

  async fail(
    ip: string,
    user: string,
    now = Date.now(),
    cfg: LockoutConfig
  ): Promise<LockState> {
    const log = (this.fails.get(ip) ?? []).filter(
      (f) => f.at > now - cfg.windowMs
    );
    log.push({ user, at: now });
    this.fails.set(ip, log);
    if (log.filter((f) => f.user === user).length >= cfg.userMax) {
      this.lock(ip, user, now + cfg.lockMs);
    }
    if (log.length >= cfg.ipMax) this.lock(ip, null, now + cfg.lockMs);
    return this.state(ip, user, now);
  }

  async clear(ip: string, user: string): Promise<void> {
    for (const f of this.fails.get(ip) ?? [])
      if (f.user === user) f.user = null;
  }

  async state(ip: string, user: string, now = Date.now()): Promise<LockState> {
    const l = this.locks.get(ip);
    const until = Math.max(l?.get(user) ?? 0, l?.get(null) ?? 0);
    return until > now
      ? { locked: true, retryAfterMs: until - now }
      : { locked: false, retryAfterMs: 0 };
  }

  private lock(ip: string, user: string | null, until: number): void {
    const l = this.locks.get(ip) ?? new Map<string | null, number>();
    l.set(user, Math.max(l.get(user) ?? 0, until));
    this.locks.set(ip, l);
  }
}

/**
 * Migration 084's `edge_auth_*` functions. Uses the database clock by
 * default so every app instance shares one time source. Errors propagate
 * (the host answers 500): a lockout that cannot be read is not skipped.
 */
export class RpcLockoutStore implements LockoutStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly opts: RpcClockOptions = {}
  ) {}

  async fail(
    ip: string,
    user: string,
    now: number | undefined,
    cfg: LockoutConfig
  ): Promise<LockState> {
    const data = await callEdgeRpc(this.client, 'edge_auth_fail', {
      p_ip: ip,
      p_user_key: user,
      ...callerNow(this.opts.useCallerClock, now),
      p_ip_max: cfg.ipMax,
      p_user_max: cfg.userMax,
      p_window_ms: cfg.windowMs,
      p_lock_ms: cfg.lockMs,
    });
    return toState('edge_auth_fail', data);
  }

  async clear(ip: string, user: string): Promise<void> {
    await callEdgeRpc(this.client, 'edge_auth_success', {
      p_ip: ip,
      p_user_key: user,
    });
  }

  async state(
    ip: string,
    user: string,
    now: number | undefined
  ): Promise<LockState> {
    const data = await callEdgeRpc(this.client, 'edge_auth_lock_state', {
      p_ip: ip,
      p_user_key: user,
      ...callerNow(this.opts.useCallerClock, now),
    });
    return toState('edge_auth_lock_state', data);
  }
}

function toState(fn: string, data: unknown): LockState {
  const { locked, retry_after_ms } = firstRow(fn, data);
  if (typeof locked !== 'boolean' || typeof retry_after_ms !== 'number') {
    throw new Error(`${fn} returned a malformed row`);
  }
  return locked
    ? { locked: true, retryAfterMs: retry_after_ms }
    : { locked: false, retryAfterMs: 0 };
}
