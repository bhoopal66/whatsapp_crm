/**
 * Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (src/assist/router.ts).
 *
 * The model-facing tool router. Its type exposes ONLY execute(): there is no confirm / deny / consume on it, so the
 * assistant's tool-call path cannot reach the human ConfirmApi. A NEEDS_CONFIRMATION result gives the model the
 * pendingId only; the human prompt (with the nonce) goes to notifyHuman, which the application wires to the
 * authenticated channel. Every executed call's outcome is audited through guard.recordExecution (never masking the
 * handler's result or error).
 */
import {
  normalizeCall,
  type AssistContext,
  type AssistGuard,
  type ToolCall,
} from './guard';

export type ToolHandler = (
  args: unknown,
  ctx: AssistContext
) => Promise<unknown>;

export type RouterResult =
  | { status: 'ok'; result: unknown }
  | { status: 'needs_confirmation'; pendingId: string }
  | { status: 'denied'; reason: string; retryAfterMs?: number }
  | { status: 'error'; message: string };

export interface ModelToolRouter {
  execute(ctx: AssistContext, call: ToolCall): Promise<RouterResult>;
}

export function createModelToolRouter(
  guard: AssistGuard,
  handlers: Readonly<Record<string, ToolHandler>>,
  notifyHuman: (
    ctx: AssistContext,
    pendingId: string,
    humanPrompt: string
  ) => Promise<void>
): ModelToolRouter {
  const router: ModelToolRouter = {
    async execute(ctx, rawCall) {
      const call = normalizeCall(rawCall);
      const handler = Object.hasOwn(handlers, call.tool)
        ? handlers[call.tool]
        : undefined;
      // An unknown tool still goes through the guard: audited as DENY UNKNOWN_TOOL and counted against the run cap.
      const d = await guard.check(ctx, call, { unknownTool: !handler });
      if (d.kind === 'DENY')
        return {
          status: 'denied',
          reason: d.reason,
          ...(d.retryAfterMs !== undefined
            ? { retryAfterMs: d.retryAfterMs }
            : {}),
        };
      if (d.kind === 'NEEDS_CONFIRMATION') {
        try {
          await notifyHuman(ctx, d.pendingId, d.humanPrompt);
        } catch {
          // The human never saw the nonce: cancel the pending row (audited DENY:NOTIFY_FAILED, frees the user's cap
          // slot; best effort, never throws). Nothing is executed.
          await guard.cancelPending(d.pendingId, 'NOTIFY_FAILED');
          return { status: 'denied', reason: 'NOTIFY_FAILED' };
        }
        return { status: 'needs_confirmation', pendingId: d.pendingId };
      }
      if (!handler) return { status: 'denied', reason: 'UNKNOWN_TOOL' }; // check never allows an unknown tool
      let result: unknown;
      try {
        result = await handler(call.args, ctx);
      } catch (e) {
        await guard.recordExecution(ctx, call, d, { error: e });
        return {
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        };
      }
      await guard.recordExecution(ctx, call, d);
      return { status: 'ok', result };
    },
  };
  return Object.freeze(router);
}
