/**
 * Message check before sending (lib/insights/compose-check.ts): one
 * TypeSafe request that judges an agent's draft before it goes out.
 *
 * Not a safety check: it warns a person and never blocks a send, so it
 * ignores the account's switches (ts_account_settings), reads no policy
 * and writes no decision-log row. It still goes through the same gateway
 * — PII guard, size budget, its own `compose_check` breaker, never
 * throws — and only runs for accounts the install allows
 * (TS_ACCOUNT_IDS) on an install with an API key. A failure is
 * `{ ok: false }`, and the caller keeps its deterministic rules only.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  composeCheckQuestions,
  type ComposeCheckQuestion,
  type ComposeCheckState,
} from '../questions/compose-check';
import { clip, redactClipped } from './common';
import { extractFigures } from './guardrail';

export interface ComposeCheckInput {
  accountId: string;
  /** The agent's draft, raw: redacted here before anything leaves. */
  draft: string;
  /** The last few messages of the chat, oldest first. */
  recentTurns?: { from: 'customer' | 'business'; text: string }[];
  /** The draft would start a conversation on a linked-device number. */
  isStart: boolean;
  /** Hard deadline for the whole call, retries included. Default 1800 ms. */
  deadlineMs?: number;
}

export type ComposeCheckFigures = Partial<Record<ComposeCheckQuestion, number>>;

export type ComposeCheckJudgment =
  | {
      ok: true;
      /** P(yes) per question asked; `cold_pitch` only when `isStart`. */
      figures: ComposeCheckFigures;
      latencyMs: number;
    }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: the answer came from another
       *  model than the pinned one the thresholds assume. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const COMPOSE_CHECK_DEADLINE_MS = 1800;
const MAX_TURNS = 4;
const MAX_DRAFT_CHARS = 4000;
const MAX_TURN_CHARS = 1000;

/**
 * P(yes) at or above which a question becomes a warning. UNCALIBRATED:
 * first guesses, set high so an agent is not nagged, to be tuned from
 * compose_check_events (how often each fires and is sent anyway).
 */
export const COMPOSE_CHECK_THRESHOLDS = {
  promise: 0.7,
  terms: 0.75,
  /** `terms` when the draft itself carries a % or AED-style figure. */
  termsWithFigure: 0.5,
  secrets: 0.6,
  tone: 0.75,
  cold_pitch: 0.7,
} as const;

/** The questions whose figures crossed their threshold, in question order. */
export function composeCheckWarnings(
  figures: ComposeCheckFigures,
  draft: string
): ComposeCheckQuestion[] {
  const t = COMPOSE_CHECK_THRESHOLDS;
  const hasFigure = extractFigures(clip(draft, MAX_DRAFT_CHARS)).length > 0;
  const at = (q: ComposeCheckQuestion, min: number) => (figures[q] ?? 0) >= min;
  const out: ComposeCheckQuestion[] = [];
  if (at('promise', t.promise)) out.push('promise');
  if (at('terms', hasFigure ? t.termsWithFigure : t.terms)) out.push('terms');
  if (at('secrets', t.secrets)) out.push('secrets');
  if (at('tone', t.tone)) out.push('tone');
  if (at('cold_pitch', t.cold_pitch)) out.push('cold_pitch');
  return out;
}

/** Redacted TypeSafe state for the compose check. */
export function buildComposeCheckState(
  input: Pick<ComposeCheckInput, 'draft' | 'recentTurns' | 'isStart'>
): ComposeCheckState {
  return {
    draft: redactClipped(input.draft, MAX_DRAFT_CHARS),
    recent_turns: (input.recentTurns ?? []).slice(-MAX_TURNS).map((t) => ({
      from: t.from,
      text: redactClipped(t.text, MAX_TURN_CHARS),
    })),
    is_start: input.isStart,
  };
}

export async function runComposeCheck(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: ComposeCheckInput
): Promise<ComposeCheckJudgment> {
  if (!accountEnabled(deps.config, input.accountId) || !deps.gateway.hasKey())
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const questions = composeCheckQuestions(input.isStart);
  const res = await deps.gateway.ask(
    'compose_check',
    buildComposeCheckState(input),
    questions,
    input.accountId,
    { deadlineMs: input.deadlineMs ?? COMPOSE_CHECK_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const answers = res.result.answers as Record<string, { noul: number }>;
  const figures: ComposeCheckFigures = {};
  for (const q of Object.keys(questions) as ComposeCheckQuestion[]) {
    const p = answers[q]?.noul;
    if (typeof p === 'number' && Number.isFinite(p)) figures[q] = p;
  }
  return { ok: true, figures, latencyMs: res.latencyMs };
}
