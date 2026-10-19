/**
 * Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (src/assist/guard.ts), moved from
 * node-postgres to supabase-js on the service-role client (migration 120). "workspace" (workspaceId) is the wacrm
 * account id.
 *
 * AssistGuard: one decision per assistant tool call. Order, first refusal wins:
 *   1 rate limit (user + workspace, atomic, fail-closed)          → DENY RATE_LIMITED | RATE_STATE_UNAVAILABLE
 *   2 loop guard (counted per call before execution)              → DENY CALL_CAP | LOOP_REPEAT | CIRCUIT_OPEN
 *     An admitted call that ends in anything but ALLOW is settled on the loop guard, so a refused half-open trial
 *     cannot wedge the breaker. ALLOW carries the callId; the router reports the handler outcome with it.
 *   3 risk: needsConfirmation(registry.risk(tool), mode)?
 *       no                                                        → ALLOW
 *       yes, call carries pendingId → ConfirmationGate.consume (human-confirmed, same user/workspace, same hash, once)
 *                                                                 → ALLOW CONFIRMED | DENY <refusal>
 *       yes, otherwise → ConfirmationGate.request                 → NEEDS_CONFIRMATION(pendingId)
 *                        (user already at the open-pending cap)   → DENY PENDING_CAP (no row, no prompt)
 * Before 3: a tool the router has no handler for → DENY UNKNOWN_TOOL (after 1 and 2, so it is audited and counts
 * against the run cap); args that are not JSON, or a context the rate key or loopKey cannot be built from →
 * DENY BAD_REQUEST (audited; check never rejects for them). Absent args are treated as {}.
 * Nothing the model puts in args (confirm: true, approved: "yes", ...) is read: args only feed the action hash.
 *
 * Every decision is appended to public.assist_audit (kind 'decision'); if that append fails the decision is
 * DENY AUDIT_UNAVAILABLE (fail closed). wacrm change: there are no client transactions (the reference's tx.ts is not
 * ported). assist_pending_consume writes the 'ALLOW:CONFIRMED' decision row itself in the same SQL call, so the guard
 * writes no second one; when that insert fails the call raises (AuditUnavailableError), nothing is consumed, and a
 * retry executes the action once. A consume refusal is audited here as 'DENY:<reason>'.
 * A NEEDS_CONFIRMATION whose decision append fails becomes DENY AUDIT_UNAVAILABLE and its pending row is cancelled
 * (cancelPending), as the router does when notifying the human fails, so the row does not hold one of the user's
 * open-pending slots. After the handler runs the router calls recordExecution (kind 'execution': executed_ok |
 * executed_error + error class). A handler that fails after a consume leaves the row consumed: the human must confirm
 * a new pending action. The human prompt (with the nonce) is returned for the application to deliver to the human;
 * the model router never forwards it to the model.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { consoleLogger, type EdgeLogger } from '@/lib/edge/logger';
import { actionHash } from './canonical';
import {
  AuditUnavailableError,
  PendingCapError,
  type ConfirmationGate,
} from './confirm';
import type { LoopDecision, LoopGuard } from './loop';
import type { RateDecision, RateLimiter } from './rate';
import {
  DEFAULT_MODE,
  needsConfirmation,
  type AutonomyMode,
  type RiskLevel,
  type ToolRegistry,
} from './registry';

export interface AssistContext {
  readonly runId: string;
  readonly userId: string;
  /** The wacrm account id. */
  readonly workspaceId: string;
  readonly mode?: AutonomyMode;
}

export interface ToolCall {
  readonly tool: string;
  /** Absent (undefined) args are treated as {}: a no-argument tool. */
  readonly args?: unknown;
  /** Set when the model re-issues an action a human has confirmed. */
  readonly pendingId?: string;
}

export type AssistDecision =
  | {
      kind: 'ALLOW';
      reason: 'ALLOWED' | 'CONFIRMED';
      risk: RiskLevel;
      callId: number;
    }
  | {
      kind: 'NEEDS_CONFIRMATION';
      pendingId: string;
      humanPrompt: string;
      risk: RiskLevel;
    }
  | { kind: 'DENY'; reason: string; retryAfterMs?: number };

type Consume = {
  kind: 'CONSUME';
  pendingId: string;
  risk: RiskLevel;
  callId: number;
};

export class AssistGuard {
  constructor(
    private readonly deps: {
      /** Service-role client: assist_audit is RLS-forced with no policy. */
      db: SupabaseClient;
      registry: ToolRegistry;
      rate: RateLimiter;
      loop: LoopGuard;
      gate: ConfirmationGate;
      defaultMode?: AutonomyMode;
      /** Where a failed execution-audit append or pending cancel is reported (default consoleLogger). */
      logger?: EdgeLogger;
    }
  ) {}

  get loop(): LoopGuard {
    return this.deps.loop;
  }

  /** unknownTool: the router has no handler for call.tool (decided DENY UNKNOWN_TOOL, audited, counted). */
  async check(
    ctx: AssistContext,
    rawCall: ToolCall,
    opts: { unknownTool?: boolean } = {}
  ): Promise<AssistDecision> {
    const call = normalizeCall(rawCall);
    const admitted: { callId?: number } = {};
    const d = await this.decide(ctx, call, admitted, opts.unknownTool === true);
    const decision =
      d.kind === 'CONSUME'
        ? await this.consume(ctx, call, d)
        : await this.audit(ctx, call, d);
    // The prompt is never delivered for a NEEDS_CONFIRMATION that could not be audited: free its pending slot.
    if (d.kind === 'NEEDS_CONFIRMATION' && decision.kind === 'DENY')
      await this.cancelPending(d.pendingId, decision.reason);
    if (decision.kind !== 'ALLOW' && admitted.callId !== undefined)
      this.deps.loop.settle(ctx.runId, admitted.callId);
    return decision;
  }

  /**
   * Appends the execution outcome of an ALLOWed call (kind 'execution', executed_ok | executed_error with the error
   * class name only: never the args or the message) and feeds the loop breaker. An audit failure is logged and
   * swallowed: it never masks the handler's result or error.
   */
  async recordExecution(
    ctx: AssistContext,
    call: ToolCall,
    d: Extract<AssistDecision, { kind: 'ALLOW' }>,
    failure?: { error: unknown }
  ): Promise<void> {
    const failed = failure !== undefined;
    const outcome = failed ? 'executed_error' : 'executed_ok';
    this.deps.loop.record(ctx.runId, d.callId, failed ? 'error' : 'ok');
    const errorClass = !failed
      ? undefined
      : failure.error instanceof Error
        ? failure.error.constructor?.name || 'Error'
        : 'NonError';
    try {
      const { error } = await this.deps.db.from('assist_audit').insert({
        kind: 'execution',
        actor: `assistant:${ctx.userId}`,
        account_id: ctx.workspaceId,
        user_id: ctx.userId,
        run_id: ctx.runId,
        tool: call.tool,
        pending_id: d.reason === 'CONFIRMED' ? (call.pendingId ?? null) : null,
        action_hash: hashOf(call),
        outcome,
        detail: {
          decision: `ALLOW:${d.reason}`,
          ...(errorClass ? { error: errorClass } : {}),
        },
      });
      if (error) throw new Error(error.message);
    } catch (e) {
      this.logger.warn('assist: execution audit append failed', {
        runId: ctx.runId,
        tool: call.tool,
        outcome,
        cause: causeOf(e),
      });
    }
  }

  /**
   * Best effort: pending -> denied with a 'DENY:<reason>' decision audit row (ConfirmationGate.cancelPending), for a
   * pending action the human will never see. A failure is logged and swallowed (the row then expires as before).
   */
  async cancelPending(pendingId: string, reason: string): Promise<void> {
    try {
      await this.deps.gate.cancelPending(pendingId, reason);
    } catch (e) {
      this.logger.warn('assist: pending cancel failed', {
        pendingId,
        reason,
        cause: causeOf(e),
      });
    }
  }

  private get logger(): EdgeLogger {
    return this.deps.logger ?? consoleLogger;
  }

  private get modeOf(): (ctx: AssistContext) => AutonomyMode {
    return (ctx) => ctx.mode ?? this.deps.defaultMode ?? DEFAULT_MODE;
  }

  private async decide(
    ctx: AssistContext,
    call: ToolCall,
    admitted: { callId?: number },
    unknownTool: boolean
  ): Promise<AssistDecision | Consume> {
    let rate: RateDecision;
    try {
      rate = await this.deps.rate.check(ctx);
    } catch (e) {
      // check refuses a malformed user / account id synchronously; database errors are already RATE_STATE_UNAVAILABLE.
      return {
        kind: 'DENY',
        reason:
          e instanceof TypeError ? 'BAD_REQUEST' : 'RATE_STATE_UNAVAILABLE',
      };
    }
    if (!rate.allowed)
      return rate.reason === 'RATE_LIMITED'
        ? { kind: 'DENY', reason: rate.reason, retryAfterMs: rate.retryAfterMs }
        : { kind: 'DENY', reason: rate.reason };

    let loop: LoopDecision;
    try {
      loop = this.deps.loop.admit(
        ctx.runId,
        call,
        this.deps.registry.spec(call.tool).loopKey
      );
    } catch {
      return { kind: 'DENY', reason: 'BAD_REQUEST' }; // args (or loopKey(args)) are not JSON; the attempt was counted
    }
    if (!loop.ok)
      return {
        kind: 'DENY',
        reason: loop.reason,
        ...(loop.retryAfterMs !== undefined
          ? { retryAfterMs: loop.retryAfterMs }
          : {}),
      };
    const callId = (admitted.callId = loop.callId);
    if (unknownTool) return { kind: 'DENY', reason: 'UNKNOWN_TOOL' };
    if (hashOf(call) === null) return { kind: 'DENY', reason: 'BAD_REQUEST' };

    const risk = this.deps.registry.risk(call.tool);
    if (!needsConfirmation(risk, this.modeOf(ctx)))
      return { kind: 'ALLOW', reason: 'ALLOWED', risk, callId };

    if (call.pendingId !== undefined)
      return { kind: 'CONSUME', pendingId: call.pendingId, risk, callId };
    try {
      const p = await this.deps.gate.request(
        { tool: call.tool, args: call.args },
        ctx,
        this.deps.registry.spec(call.tool)
      );
      return {
        kind: 'NEEDS_CONFIRMATION',
        pendingId: p.pendingId,
        humanPrompt: p.humanPrompt,
        risk,
      };
    } catch (e) {
      return {
        kind: 'DENY',
        reason:
          e instanceof PendingCapError
            ? 'PENDING_CAP'
            : 'CONFIRM_STATE_UNAVAILABLE',
      };
    }
  }

  /**
   * confirmed -> consumed. On success assist_pending_consume has already written the 'ALLOW:CONFIRMED' decision row in
   * the same call, so nothing more is appended here. AuditUnavailableError: that row could not be written and nothing
   * was consumed (the row stays 'confirmed' for a retry). A refusal, or any other failure, is audited here.
   */
  private async consume(
    ctx: AssistContext,
    call: ToolCall,
    c: Consume
  ): Promise<AssistDecision> {
    try {
      const r = await this.deps.gate.consume(
        c.pendingId,
        { tool: call.tool, args: call.args },
        ctx,
        {
          runId: ctx.runId,
          tool: call.tool,
          detail: { mode: this.modeOf(ctx), risk: c.risk },
        }
      );
      if (r.ok)
        return {
          kind: 'ALLOW',
          reason: 'CONFIRMED',
          risk: c.risk,
          callId: c.callId,
        };
      return this.audit(ctx, call, { kind: 'DENY', reason: r.reason });
    } catch (e) {
      if (e instanceof AuditUnavailableError)
        return { kind: 'DENY', reason: 'AUDIT_UNAVAILABLE' };
      return this.audit(ctx, call, {
        kind: 'DENY',
        reason: 'CONFIRM_STATE_UNAVAILABLE',
      });
    }
  }

  private async audit(
    ctx: AssistContext,
    call: ToolCall,
    d: AssistDecision
  ): Promise<AssistDecision> {
    const outcome =
      d.kind === 'ALLOW'
        ? `ALLOW:${d.reason}`
        : d.kind === 'DENY'
          ? `DENY:${d.reason}`
          : 'NEEDS_CONFIRMATION';
    try {
      const { error } = await this.deps.db.from('assist_audit').insert({
        kind: 'decision',
        actor: `assistant:${ctx.userId}`,
        account_id: ctx.workspaceId,
        user_id: ctx.userId,
        run_id: ctx.runId,
        tool: call.tool,
        pending_id: d.kind === 'NEEDS_CONFIRMATION' ? d.pendingId : null,
        action_hash: hashOf(call),
        outcome,
        detail: {
          mode: this.modeOf(ctx),
          ...(d.kind !== 'DENY' ? { risk: d.risk } : {}),
        },
      });
      if (error) return { kind: 'DENY', reason: 'AUDIT_UNAVAILABLE' };
      return d;
    } catch {
      return { kind: 'DENY', reason: 'AUDIT_UNAVAILABLE' };
    }
  }
}

/** Absent args are {} (a no-argument tool). */
export function normalizeCall(call: ToolCall): ToolCall & { args: unknown } {
  return call.args === undefined
    ? { ...call, args: {} }
    : (call as ToolCall & { args: unknown });
}

function hashOf(call: ToolCall): string | null {
  try {
    return actionHash(call.tool, call.args);
  } catch {
    return null;
  }
}

const causeOf = (e: unknown): string =>
  e instanceof Error ? e.constructor?.name || 'Error' : 'NonError';
