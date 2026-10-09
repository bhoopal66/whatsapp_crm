/**
 * Model-tier routing judgment (lib/ai/router.ts): one TypeSafe request
 * that says what kind of reply a customer message needs.
 *
 * Not a safety check, so unlike the others it ignores the account's
 * switches (ts_account_settings), reads no policy and writes no
 * decision-log row. It still goes through the same gateway — PII guard,
 * size budget, breakers (its own `route` breaker), never throws — and
 * only runs for accounts the install allows (TS_ACCOUNT_IDS) on an
 * install with an API key. A failure is `{ ok: false }`, and the router
 * falls back to its heuristic.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  ROUTE_KINDS,
  ROUTE_QUESTIONS,
  type RouteKind,
  type RouteState,
} from '../questions/route';
import { redactClipped } from './common';

export interface RouteInput {
  accountId: string;
  /** Everything the customer wrote since the bot last spoke. */
  message: string;
  recentTurns?: { from: 'customer' | 'business'; text: string }[];
  journeyStage: string;
  /** Hard deadline for the whole call, retries included. Default 2500 ms. */
  deadlineMs?: number;
}

export type RouteJudgment =
  | {
      ok: true;
      kind: { label: RouteKind; p: Record<RouteKind, number> };
      /** Expected complexity level, 0..3. */
      complexity: number;
      /** P(answering needs specific business facts). */
      needsFacts: number;
      latencyMs: number;
    }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: the answer came from another
       *  model than the pinned one the router's thresholds assume. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const ROUTE_DEADLINE_MS = 2500;
const MAX_TURNS = 6;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TURN_CHARS = 1000;

/** Redacted TypeSafe state for the route judgment. */
export function buildRouteState(
  input: Pick<RouteInput, 'message' | 'recentTurns' | 'journeyStage'>
): RouteState {
  return {
    message: redactClipped(input.message, MAX_MESSAGE_CHARS, { tail: true }),
    recent_turns: (input.recentTurns ?? []).slice(-MAX_TURNS).map((t) => ({
      from: t.from,
      text: redactClipped(t.text, MAX_TURN_CHARS),
    })),
    journey_stage: input.journeyStage,
  };
}

export async function runRoute(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: RouteInput
): Promise<RouteJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const res = await deps.gateway.ask(
    'route',
    buildRouteState(input),
    ROUTE_QUESTIONS,
    input.accountId,
    { deadlineMs: input.deadlineMs ?? ROUTE_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const a = res.result.answers;
  const probs = (
    a.kind as { probabilities?: Partial<Record<RouteKind, number>> }
  ).probabilities;
  const p = Object.fromEntries(
    (Object.keys(ROUTE_KINDS) as RouteKind[]).map((k) => [
      k,
      probs?.[k] ?? (k === a.kind.choice ? a.kind.confidence : 0),
    ])
  ) as Record<RouteKind, number>;
  return {
    ok: true,
    kind: { label: a.kind.choice, p },
    complexity: a.complexity.score,
    needsFacts: a.needs_business_facts.noul,
    latencyMs: res.latencyMs,
  };
}
