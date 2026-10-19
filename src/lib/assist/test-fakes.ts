// Test-only fakes for the assist guard and router tests (not imported by app code). The real ConfirmationGate and
// LoopGuard run on a fake supabase-js client: `rpc` answers from a per-function script and `from(table).insert`
// records rows (or fails on demand); `from(...).select(...).eq(...).maybeSingle()` serves the pending row the gate
// reads when classifying a refusal. The rate limiter is a scripted stub.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ConfirmationGate } from './confirm';
import { AssistGuard, type AssistContext } from './guard';
import { LoopGuard, type Clock } from './loop';
import type { RateDecision, RateLimiter } from './rate';
import { ToolRegistry } from './registry';

type Args = Record<string, unknown>;
export type Answer = {
  data?: unknown;
  error?: { message: string; code?: string; hint?: string | null };
};

export class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  readonly inserts: { table: string; row: Args }[] = [];
  /** Inserts into assist_audit whose outcome matches fail with an error (null: none fail). */
  failAudit: ((row: Args) => boolean) | null = null;
  pendingRow: Args | null = null;
  constructor(readonly script: Record<string, Answer | Answer[]> = {}) {}

  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    const s = this.script[fn];
    const a = Array.isArray(s) ? s.shift() : s;
    if (a === undefined) throw new Error(`unscripted rpc ${fn}`);
    return { data: a.data ?? null, error: a.error ?? null };
  }

  from(table: string) {
    const b = {
      insert: async (row: Args) => {
        if (table === 'assist_audit' && this.failAudit?.(row))
          return { error: { message: 'audit down' } };
        this.inserts.push({ table, row });
        return { error: null };
      },
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: this.pendingRow, error: null }),
    };
    return b;
  }

  /** Decision / execution rows appended to assist_audit by the TS. */
  audits(kind?: string): Args[] {
    return this.inserts
      .filter((i) => i.table === 'assist_audit')
      .map((i) => i.row)
      .filter((r) => kind === undefined || r.kind === kind);
  }

  rpcCalls(fn: string): Args[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
}

export const USER = '11111111-1111-4111-8111-111111111111';
export const ACCOUNT = '22222222-2222-4222-8222-222222222222';
export const PENDING = '33333333-3333-4333-8333-333333333333';
export const NONCE = 'abcdef0123456789abcd';

export const ctx = (over: Partial<AssistContext> = {}): AssistContext => ({
  runId: 'run-1',
  userId: USER,
  workspaceId: ACCOUNT,
  ...over,
});

export class FakeClock implements Clock {
  constructor(public t = 1_000_000) {}
  now(): number {
    return this.t;
  }
}

export function makeGuard(
  opts: {
    script?: Record<string, Answer | Answer[]>;
    rate?: RateDecision | (() => Promise<RateDecision>);
    loop?: LoopGuard;
    logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  } = {}
) {
  const db = new FakeDb(opts.script);
  const client = db as unknown as SupabaseClient;
  const clock = new FakeClock();
  const rateCheck =
    typeof opts.rate === 'function'
      ? opts.rate
      : async () => opts.rate ?? ({ allowed: true } as RateDecision);
  const rate = { calls: 0 } as { calls: number; check: unknown };
  rate.check = (s: unknown) => {
    rate.calls++;
    void s;
    return rateCheck();
  };
  const loop = opts.loop ?? new LoopGuard({ clock });
  const registry = new ToolRegistry();
  const gate = new ConfirmationGate(client, { registry, clock });
  const guard = new AssistGuard({
    db: client,
    registry,
    rate: rate as unknown as RateLimiter,
    loop,
    gate,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return { db, guard, loop, gate, rate, clock };
}

/** assist_pending_request answering one stored row with the DB-generated nonce. */
export const requestOk = (id = PENDING, nonce = NONCE): Answer => ({
  data: [{ id, nonce }],
});
