// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18. "workspace" here means the wacrm
// account id (uuid).
/**
 * LoopGuard: pure, in-memory, per assistant run (runId). Every tool call is admitted (or refused) synchronously
 * BEFORE it executes, so each call of a parallel batch is counted on its own and a batch cannot overshoot the cap.
 *   CALL_CAP      the run has already made maxCalls tool calls (default 8). Every attempt counts, refused ones included,
 *                 and the cap is checked first, so a run always ends (even while the breaker refuses every call).
 *   LOOP_REPEAT   the same (tool, canonical args hash, pendingId) was already attempted maxIdentical times (default 2: the 3rd
 *                 is refused).
 *                 With the tool's registry loopKey(args), the hash is of loopKey(args) instead of the full args.
 *   CIRCUIT_OPEN  errorThreshold consecutive errors (default 3) open the breaker for backoffMs[step] (1s, 5s, 30s, then 30s);
 *                 once that elapses on the injected clock it half-opens: one trial call is admitted; success closes it
 *                 (and resets the backoff), an error re-opens it with the next step. A trial that never executes (the
 *                 caller refused it after admit: confirmation needed, consume refused, audit failed) is released with
 *                 settle(runId, callId), counting neither success nor error, so the next admit is the trial.
 *                 Outcomes are tied to the call: record(runId, callId, outcome) ignores a call admitted before the
 *                 last trip, so a late ok cannot close the breaker or reset trips, and a late error is not the trial.
 * State lives only between begin/first admit and end(runId); end() deletes it.
 */
import { actionHash } from './canonical';

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export type LoopReason = 'LOOP_REPEAT' | 'CALL_CAP' | 'CIRCUIT_OPEN';
export type LoopDecision =
  | { ok: true; callId: number }
  | { ok: false; reason: LoopReason; retryAfterMs?: number };

export interface LoopGuardOptions {
  maxCalls?: number;
  maxIdentical?: number;
  errorThreshold?: number;
  backoffMs?: readonly number[];
  clock?: Clock;
}

interface RunState {
  calls: number;
  seen: Map<string, number>;
  consecutiveErrors: number;
  openUntil: number | null;
  trips: number;
  /** callId of the admitted half-open trial whose outcome is still pending, or null. */
  trialCallId: number | null;
  /** s.calls at the last trip: calls with callId <= trippedAt were admitted before it. */
  trippedAt: number;
}

export class LoopGuard {
  readonly maxCalls: number;
  readonly maxIdentical: number;
  readonly errorThreshold: number;
  readonly backoffMs: readonly number[];
  private readonly clock: Clock;
  private readonly runs = new Map<string, RunState>();

  constructor(opts: LoopGuardOptions = {}) {
    this.maxCalls = opts.maxCalls ?? 8;
    this.maxIdentical = opts.maxIdentical ?? 2;
    this.errorThreshold = opts.errorThreshold ?? 3;
    this.backoffMs = opts.backoffMs ?? [1_000, 5_000, 30_000];
    this.clock = opts.clock ?? systemClock;
    if (this.backoffMs.length === 0)
      throw new TypeError('LoopGuard: backoffMs must not be empty');
  }

  private state(runId: string): RunState {
    let s = this.runs.get(runId);
    if (!s) {
      s = {
        calls: 0,
        seen: new Map(),
        consecutiveErrors: 0,
        openUntil: null,
        trips: 0,
        trialCallId: null,
        trippedAt: 0,
      };
      this.runs.set(runId, s);
    }
    return s;
  }

  /** Synchronous: decide and count this call before it runs. An admitted call's callId identifies it to settle/record. */
  admit(
    runId: string,
    call: { tool: string; args?: unknown; pendingId?: string },
    loopKey?: (args: unknown) => unknown
  ): LoopDecision {
    const s = this.state(runId);
    if (s.calls >= this.maxCalls) return { ok: false, reason: 'CALL_CAP' };
    s.calls += 1;
    const callId = s.calls;
    if (s.openUntil !== null) {
      const now = this.clock.now();
      if (now < s.openUntil)
        return {
          ok: false,
          reason: 'CIRCUIT_OPEN',
          retryAfterMs: s.openUntil - now,
        };
      // Backoff elapsed but the single trial has not reported yet: suggest the current backoff step as the wait.
      if (s.trialCallId !== null)
        return {
          ok: false,
          reason: 'CIRCUIT_OPEN',
          retryAfterMs:
            this.backoffMs[Math.min(s.trips - 1, this.backoffMs.length - 1)]!,
        };
    }
    // pendingId is part of the key: re-issuing a human-confirmed action (e.g. after AUDIT_UNAVAILABLE) is not a repeat
    // of the request that created it. A made-up pendingId still counts against maxCalls and is refused by consume.
    const h = `${actionHash(call.tool, loopKey ? loopKey(call.args) : call.args)}|${call.pendingId ?? ''}`;
    const n = s.seen.get(h) ?? 0;
    s.seen.set(h, n + 1);
    if (n >= this.maxIdentical) return { ok: false, reason: 'LOOP_REPEAT' };
    if (s.openUntil !== null) s.trialCallId = callId; // half-open: this is the single trial
    return { ok: true, callId };
  }

  /** An admitted call will not execute: release it if it is the half-open trial. Counts neither success nor error. */
  settle(runId: string, callId: number): void {
    const s = this.runs.get(runId);
    if (s && s.trialCallId === callId) s.trialCallId = null;
  }

  /** Report the outcome of an executed call by the callId admit returned. */
  record(runId: string, callId: number, outcome: 'ok' | 'error'): void {
    const s = this.runs.get(runId);
    if (!s) return;
    if (callId <= s.trippedAt) return; // admitted before the last trip: says nothing about the breaker now
    if (outcome === 'ok') {
      s.consecutiveErrors = 0;
      if (s.openUntil !== null) {
        s.openUntil = null;
        s.trips = 0;
      }
      s.trialCallId = null;
      return;
    }
    s.consecutiveErrors += 1;
    if (s.trialCallId !== null || s.consecutiveErrors >= this.errorThreshold) {
      const step =
        this.backoffMs[Math.min(s.trips, this.backoffMs.length - 1)]!;
      s.openUntil = this.clock.now() + step;
      s.trips += 1;
      s.trippedAt = s.calls;
      s.trialCallId = null;
      s.consecutiveErrors = 0;
    }
  }

  end(runId: string): void {
    this.runs.delete(runId);
  }

  /** Number of runs with live state (for leak checks). */
  get activeRuns(): number {
    return this.runs.size;
  }
}
