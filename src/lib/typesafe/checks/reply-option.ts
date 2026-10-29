/**
 * Typed-reply judgment (lib/flows/typed-reply-judge.ts): one TypeSafe
 * request that says which offered button or list row a typed reply
 * chooses, if any.
 *
 * A SELECTION judgment, not a safety check — like checks/intent-match.ts
 * it ignores the account's switches (ts_account_settings), reads no
 * policy and writes no decision-log row, and it rides the same
 * `intent_match` caller (breaker and content-failure keys), since both
 * sit behind the same Smart insights switch. It goes through the gateway
 * (PII guard, size budget), never throws, and only runs for accounts the
 * install allows (TS_ACCOUNT_IDS) on an install with an API key. A
 * failure is `{ ok: false }`, and the flow's fallback policy runs.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  buildReplyOptionQuestions,
  type ReplyOptionState,
  type ReplyOptionText,
} from '../questions/reply-option';
import { redactClipped } from './common';

export interface ReplyOptionInput {
  accountId: string;
  /** The node's body text, as the customer saw it. */
  prompt: string;
  /** The customer's typed reply. */
  message: string;
  /** In display order; at most REPLY_OPTION_MAX_OPTIONS are offered. */
  options: ReplyOptionText[];
  /** Hard deadline for the whole call, retries included. Default 2000 ms. */
  deadlineMs?: number;
}

export type ReplyOptionJudgment =
  | {
      ok: true;
      /** 0-based index into `options`, or null for `none`. */
      index: number | null;
      /** P of the chosen answer (`none` included). */
      p: number;
      latencyMs: number;
    }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: the answer came from another
       *  model than the pinned one the threshold assumes. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const REPLY_OPTION_DEADLINE_MS = 2000;
const MAX_PROMPT_CHARS = 1000;
const MAX_MESSAGE_CHARS = 1000;

/** Redacted TypeSafe state for the typed-reply judgment. */
export function buildReplyOptionState(
  input: Pick<ReplyOptionInput, 'prompt' | 'message'>
): ReplyOptionState {
  return {
    prompt: redactClipped(input.prompt, MAX_PROMPT_CHARS),
    message: redactClipped(input.message, MAX_MESSAGE_CHARS, { tail: true }),
  };
}

export async function runReplyOption(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: ReplyOptionInput
): Promise<ReplyOptionJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const { questions, keys } = buildReplyOptionQuestions(input.options);
  if (keys.length === 0) return { ok: true, index: null, p: 1, latencyMs: 0 };
  const res = await deps.gateway.ask(
    'intent_match',
    buildReplyOptionState(input),
    questions,
    input.accountId,
    { deadlineMs: input.deadlineMs ?? REPLY_OPTION_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const a = res.result.answers.option as {
    choice: string;
    confidence?: number;
    probabilities?: Record<string, number>;
  };
  const raw = a.probabilities?.[a.choice] ?? a.confidence;
  const p =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(0, Math.min(1, raw))
      : 0;
  const k = keys.indexOf(a.choice);
  return { ok: true, index: k >= 0 ? k : null, p, latencyMs: res.latencyMs };
}
