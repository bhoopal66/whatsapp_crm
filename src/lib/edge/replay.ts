/**
 * Replay guard: each inbound message id (and each status transition) is
 * processed once.
 *
 * Two-phase: `claim` takes a short lease on the key; `confirm` (called by
 * the host only after the event is durably persisted) turns it into a 24h
 * seen-key. A claim that is never confirmed (crash, failed write) lapses
 * with its lease, so the gateway's retry of that message is processed
 * instead of being dropped as a duplicate.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callEdgeRpc, callerNow, type RpcClockOptions } from './rpc';

export type ClaimState = 'new' | 'inflight' | 'done';

export interface SeenStore {
  /**
   * Atomic: take the key (→ "new") unless it holds an unexpired
   * confirmation (→ "done") or an unconfirmed claim whose lease is still
   * live (→ "inflight").
   */
  claim(key: string, token: string, leaseSeconds: number): Promise<ClaimState>;
  /** Mark the key done for ttlSeconds, only when `token` is the current claim. */
  confirm(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  /** Drop the key only when `token` is the current, still-unconfirmed claim. */
  release(key: string, token: string): Promise<boolean>;
}

export const REPLAY_TTL_SECONDS = 24 * 60 * 60;
export const CLAIM_LEASE_SECONDS = 60;

export type Claim = { state: ClaimState; token?: string };

export class ReplayGuard {
  constructor(
    private readonly store: SeenStore,
    private readonly ttlSeconds = REPLAY_TTL_SECONDS
  ) {}

  /** `token` is present only when state is "new"; pass it to `confirm`. */
  async claim(
    key: string,
    leaseSeconds: number = CLAIM_LEASE_SECONDS
  ): Promise<Claim> {
    const token = randomUUID();
    const state = await this.store.claim(key, token, leaseSeconds);
    return state === 'new' ? { state, token } : { state };
  }

  confirm(
    key: string,
    token: string,
    ttlSeconds: number = this.ttlSeconds
  ): Promise<boolean> {
    return this.store.confirm(key, token, ttlSeconds);
  }

  /** Give back an unconfirmed claim so the message can be claimed again at once. */
  release(key: string, token: string): Promise<boolean> {
    return this.store.release(key, token);
  }
}

type Rec = { until: number; confirmed: boolean; token: string | null };

export class MemorySeenStore implements SeenStore {
  private readonly recs = new Map<string, Rec>();
  constructor(private readonly clock: () => number = Date.now) {}

  async claim(key: string, token: string, leaseSeconds: number) {
    const now = this.clock();
    const r = this.recs.get(key);
    if (r !== undefined && r.until > now) {
      return r.confirmed ? 'done' : 'inflight';
    }
    this.recs.set(key, {
      until: now + leaseSeconds * 1000,
      confirmed: false,
      token,
    });
    return 'new' as const;
  }

  async confirm(key: string, token: string, ttlSeconds: number) {
    const r = this.recs.get(key);
    if (r === undefined || r.token !== token) return false;
    this.recs.set(key, {
      until: this.clock() + ttlSeconds * 1000,
      confirmed: true,
      token: null,
    });
    return true;
  }

  async release(key: string, token: string) {
    const r = this.recs.get(key);
    if (r === undefined || r.confirmed || r.token !== token) return false;
    this.recs.delete(key);
    return true;
  }

  /** Drops expired confirmations and lapsed leases; returns how many were removed. */
  purge(): number {
    const now = this.clock();
    let n = 0;
    for (const [k, r] of this.recs) {
      if (r.until <= now) {
        this.recs.delete(k);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.recs.size;
  }
}

/**
 * Migration 084's `edge_replay_*` functions: one shared key table, so
 * every app instance sees the same claims. The database clock is used
 * unless built with `useCallerClock` (then `clock()` is sent as `p_now`).
 */
export class RpcSeenStore implements SeenStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly opts: RpcClockOptions & { clock?: () => number } = {}
  ) {}

  private now(): { p_now?: string } {
    return callerNow(this.opts.useCallerClock, (this.opts.clock ?? Date.now)());
  }

  async claim(
    key: string,
    token: string,
    leaseSeconds: number
  ): Promise<ClaimState> {
    const state = await callEdgeRpc(this.client, 'edge_replay_claim', {
      p_key: key,
      p_token: token,
      p_lease_seconds: leaseSeconds,
      ...this.now(),
    });
    if (state === 'new' || state === 'inflight' || state === 'done') {
      return state;
    }
    throw new Error(`edge_replay_claim returned ${JSON.stringify(state)}`);
  }

  async confirm(key: string, token: string, ttlSeconds: number) {
    const ok = await callEdgeRpc(this.client, 'edge_replay_confirm', {
      p_key: key,
      p_token: token,
      p_ttl_seconds: ttlSeconds,
      ...this.now(),
    });
    return ok === true;
  }

  async release(key: string, token: string) {
    const ok = await callEdgeRpc(this.client, 'edge_replay_release', {
      p_key: key,
      p_token: token,
    });
    return ok === true;
  }
}
