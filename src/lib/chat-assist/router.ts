/**
 * The panel's way through 019a's assistant safety layer: one guarded
 * router per request, built from `lib/assist` and nothing else.
 *
 *   - The guard runs on the service role (the audit, rate and pending
 *     tables are RLS-forced with no policy); the handlers run on the
 *     CALLER's client (`handlers.ts`), so a write is judged by the same
 *     policies as the person's own click elsewhere.
 *   - Every call runs in the `supervised` mode: a WRITE without a
 *     confirmed pending action is held (NEEDS_CONFIRMATION) and its
 *     handler is never called; with one, the guard consumes it only for
 *     the same person, workspace, tool and arguments, once.
 *   - The confirmation prompt (with the database's nonce) goes to
 *     `notifyHuman`, which here keeps the nonce for the person's card.
 *     No model sees it: the model's turn is over before cards are made.
 */
import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { ConfirmationGate } from '@/lib/assist/confirm';
import { AssistGuard, type AssistContext } from '@/lib/assist/guard';
import { LoopGuard } from '@/lib/assist/loop';
import { RateLimiter } from '@/lib/assist/rate';
import {
  createModelToolRouter,
  type ModelToolRouter,
  type RouterResult,
  type ToolHandler,
} from '@/lib/assist/router';

import type { CardView, PlannedAction } from './actions';
import {
  CHAT_ASSIST_MODE,
  chatAssistRegistry,
  nonceFromHumanPrompt,
  type ChatAssistWriteTool,
} from './tools';

/** One request's assistant context: always supervised. */
export function chatAssistContext(args: {
  userId: string;
  accountId: string;
  runId?: string;
}): AssistContext {
  return Object.freeze({
    runId: args.runId ?? `chat-assist:${randomUUID()}`,
    userId: args.userId,
    workspaceId: args.accountId,
    mode: CHAT_ASSIST_MODE,
  });
}

export interface ChatAssistRouter {
  router: ModelToolRouter;
  /** Nonces handed to the person, by pending id (never to the model). */
  nonces: Map<string, string>;
}

/**
 * The guarded router with the panel's registry. `deps` overrides the
 * guard's parts (tests pass a fake database and rate limiter).
 */
export function createChatAssistRouter(
  admin: SupabaseClient,
  handlers: Readonly<Record<string, ToolHandler>>,
  deps: { rate?: RateLimiter; loop?: LoopGuard; gate?: ConfirmationGate } = {}
): ChatAssistRouter {
  const registry = chatAssistRegistry();
  const guard = new AssistGuard({
    db: admin,
    registry,
    rate: deps.rate ?? new RateLimiter(admin),
    loop: deps.loop ?? new LoopGuard(),
    gate: deps.gate ?? new ConfirmationGate(admin, { registry }),
    defaultMode: CHAT_ASSIST_MODE,
  });
  const nonces = new Map<string, string>();
  const router = createModelToolRouter(
    guard,
    handlers,
    async (_ctx, pendingId, humanPrompt) => {
      const nonce = nonceFromHumanPrompt(humanPrompt);
      // No nonce: the person could never confirm. The router then
      // cancels the pending row (NOTIFY_FAILED) and runs nothing.
      if (!nonce) throw new Error('no nonce in the confirmation prompt');
      nonces.set(pendingId, nonce);
    }
  );
  return { router, nonces };
}

/** A suggested action as the panel shows it. */
export type ActionCard =
  | {
      status: 'pending';
      pendingId: string;
      /** For the person's own confirm / dismiss click only. */
      nonce: string;
      tool: ChatAssistWriteTool;
      args: unknown;
      view: CardView;
      why: string;
    }
  | {
      status: 'unavailable';
      /** The guard's refusal, e.g. PENDING_CAP or RATE_LIMITED. */
      reason: string;
      tool: ChatAssistWriteTool;
      view: CardView;
      why: string;
    };

/**
 * Hold every planned action for the person: each goes through the
 * router as a WRITE with no pending id, so the guard records a pending
 * action and NOTHING runs. A result other than NEEDS_CONFIRMATION
 * becomes an unavailable card; an `ok` (which `supervised` never gives a
 * WRITE) would be a broken layer, so it throws rather than show it.
 */
export async function holdActions(
  r: ChatAssistRouter,
  ctx: AssistContext,
  planned: readonly PlannedAction[]
): Promise<ActionCard[]> {
  if (ctx.mode !== CHAT_ASSIST_MODE)
    throw new Error('chat assist: calls must run supervised');
  const cards: ActionCard[] = [];
  for (const p of planned) {
    const res = await r.router.execute(ctx, { tool: p.tool, args: p.args });
    if (res.status === 'needs_confirmation') {
      const nonce = r.nonces.get(res.pendingId);
      if (nonce) {
        cards.push({
          status: 'pending',
          pendingId: res.pendingId,
          nonce,
          tool: p.tool,
          args: p.args,
          view: p.view,
          why: p.why,
        });
        continue;
      }
    }
    if (res.status === 'ok')
      throw new Error('chat assist: a WRITE ran without confirmation');
    cards.push({
      status: 'unavailable',
      reason: res.status === 'denied' ? res.reason : 'ERROR',
      tool: p.tool,
      view: p.view,
      why: p.why,
    });
  }
  return cards;
}

/**
 * Run an action the person has confirmed: the same tool and arguments
 * with its pending id. The guard consumes the pending action (only a
 * confirmed one, only this person's, only an unchanged argument, once)
 * before the handler runs; anything else is denied and runs nothing.
 */
export function runConfirmed(
  r: ChatAssistRouter,
  ctx: AssistContext,
  call: { tool: ChatAssistWriteTool; args: unknown; pendingId: string }
): Promise<RouterResult> {
  if (ctx.mode !== CHAT_ASSIST_MODE)
    throw new Error('chat assist: calls must run supervised');
  return r.router.execute(ctx, call);
}
