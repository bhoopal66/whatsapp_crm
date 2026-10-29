/**
 * Knowledge-gap topic judgment (lib/kb/gap-recompute.ts): one TypeSafe
 * request per topic that names the topic's intent and says how well the
 * best of up to five shortlisted approved answers covers the topic's
 * representative question.
 *
 * A SELECTION judgment, not a safety check — like checks/route.ts it
 * ignores the account's switches (ts_account_settings), reads no policy
 * and writes no decision-log row. It still goes through the same gateway
 * (PII guard, size budget, its own `kb_gap` breaker), never throws, and
 * only runs for accounts the install allows (TS_ACCOUNT_IDS) on an
 * install with an API key. A failure is `{ ok: false }`, and the caller
 * stores the topic with coverage 'unknown'.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import type { Intent } from '../questions/triage';
import {
  KB_GAP_INTENT_QUESTIONS,
  buildCoverageQuestions,
  type KbGapState,
} from '../questions/kb-gap';
import { redactClipped } from './common';

export interface KbGapInput {
  accountId: string;
  /** The topic's representative question. */
  question: string;
  /** Shortlisted approved answers, best first. Only the text goes to
   *  TypeSafe; `coverage.index` is a position in this array. At most
   *  KB_GAP_MAX_ANSWERS are judged. */
  answers: string[];
  /** Hard deadline for the call, retries included. Default
   *  KB_GAP_DEADLINE_MS. */
  deadlineMs?: number;
}

export type KbGapJudgment =
  | {
      ok: true;
      /** The chosen triage intent and its probability. */
      intent: { key: Intent; p: number };
      /** The best-covering answer: its position in `answers` (null when
       *  there were none) and its expected level, 0 (does not answer)
       *  .. 2 (fully answers). */
      coverage: { index: number | null; level: number };
      latencyMs: number;
    }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: the answer came from another
       *  model than the pinned one. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const KB_GAP_DEADLINE_MS = 8000;
export const KB_GAP_MAX_ANSWERS = 5;
const MAX_QUESTION_CHARS = 1000;
const MAX_ANSWER_CHARS = 2000;

/** Redacted TypeSafe state: the question and the answers' text. */
export function buildKbGapState(
  input: Pick<KbGapInput, 'question' | 'answers'>
): KbGapState {
  return {
    question: redactClipped(input.question, MAX_QUESTION_CHARS),
    answers: input.answers
      .slice(0, KB_GAP_MAX_ANSWERS)
      .map((a) => ({ text: redactClipped(a, MAX_ANSWER_CHARS) })),
  };
}

export async function runKbGapJudgment(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: KbGapInput
): Promise<KbGapJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const state = buildKbGapState(input);
  const n = state.answers.length;
  const coverage = buildCoverageQuestions(n);
  const res = await deps.gateway.ask(
    'kb_gap',
    state,
    { ...KB_GAP_INTENT_QUESTIONS, ...coverage },
    input.accountId,
    { deadlineMs: input.deadlineMs ?? KB_GAP_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const answers = res.result.answers as unknown as Record<
    string,
    { score?: unknown }
  >;
  const intent = res.result.answers.intent;
  const key = intent.choice as Intent;
  const probs = (intent as { probabilities?: Partial<Record<Intent, number>> })
    .probabilities;
  let index: number | null = null;
  let level = 0;
  for (let k = 0; k < n; k++) {
    const s = answers[`c${k + 1}`]?.score;
    if (typeof s !== 'number' || !Number.isFinite(s)) continue;
    if (index === null || s > level) {
      index = k;
      level = s;
    }
  }
  return {
    ok: true,
    intent: { key, p: probs?.[key] ?? intent.confidence },
    coverage: { index, level: Math.max(0, Math.min(2, level)) },
    latencyMs: res.latencyMs,
  };
}
