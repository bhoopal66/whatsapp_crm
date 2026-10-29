/**
 * Meaning-trigger judgment (lib/insights/meaning.ts): one TypeSafe
 * request that gives, per candidate trigger, P(the customer's message
 * means it).
 *
 * A SELECTION judgment, not a safety check — like checks/route.ts it
 * ignores the account's switches (ts_account_settings), reads no policy
 * and writes no decision-log row. It still goes through the same gateway
 * (PII guard, size budget, its own `intent_match` breaker), never throws,
 * and only runs for accounts the install allows (TS_ACCOUNT_IDS) on an
 * install with an API key. A failure is `{ ok: false }`, and no meaning
 * trigger fires.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  buildIntentQuestions,
  type IntentCandidateText,
  type IntentMatchState,
} from '../questions/intent-match';
import { redactClipped } from './common';

export interface IntentMatchInput {
  accountId: string;
  /** The customer's message. */
  message: string;
  recentTurns?: { from: 'customer' | 'business'; text: string }[];
  /** At most INTENT_MAX_CANDIDATES are judged; `p[k]` is candidates[k]. */
  candidates: IntentCandidateText[];
  /** Hard deadline for the whole call, retries included. Default 2000 ms. */
  deadlineMs?: number;
}

export type IntentMatchJudgment =
  | { ok: true; p: number[]; latencyMs: number }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: the answer came from another
       *  model than the pinned one the thresholds assume. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const INTENT_MATCH_DEADLINE_MS = 2000;
const MAX_TURNS = 6;
const MAX_MESSAGE_CHARS = 2000;
const MAX_TURN_CHARS = 600;

/** Redacted TypeSafe state for the meaning judgment. */
export function buildIntentMatchState(
  input: Pick<IntentMatchInput, 'message' | 'recentTurns'>
): IntentMatchState {
  return {
    message: redactClipped(input.message, MAX_MESSAGE_CHARS, { tail: true }),
    recent_turns: (input.recentTurns ?? []).slice(-MAX_TURNS).map((t) => ({
      from: t.from,
      text: redactClipped(t.text, MAX_TURN_CHARS),
    })),
  };
}

export async function runIntentMatch(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: IntentMatchInput
): Promise<IntentMatchJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const { questions, keys } = buildIntentQuestions(input.candidates);
  if (keys.length === 0) return { ok: true, p: [], latencyMs: 0 };
  const res = await deps.gateway.ask(
    'intent_match',
    buildIntentMatchState(input),
    questions,
    input.accountId,
    { deadlineMs: input.deadlineMs ?? INTENT_MATCH_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const answers = res.result.answers as unknown as Record<
    string,
    { noul?: unknown }
  >;
  const p = keys.map((k) => {
    const v = answers[k]?.noul;
    return typeof v === 'number' && Number.isFinite(v)
      ? Math.max(0, Math.min(1, v))
      : 0;
  });
  return { ok: true, p, latencyMs: res.latencyMs };
}
