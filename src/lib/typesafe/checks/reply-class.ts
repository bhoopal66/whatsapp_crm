/**
 * Campaign reply sorting judgment (lib/broadcasts/reply-class.ts): one
 * TypeSafe request that sorts a customer's first reply to a broadcast
 * into one of seven classes.
 *
 * Not a safety check, so it ignores the account's switches
 * (ts_account_settings), reads no policy and writes no decision-log row.
 * It still goes through the same gateway — PII guard, size budget, its
 * own `reply_class` breaker, never throws — and only runs for accounts
 * the install allows (TS_ACCOUNT_IDS) on an install with an API key. A
 * failure is `{ ok: false }`, and the reply stays unclassified.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  REPLY_CLASS_QUESTIONS,
  type ReplyClass,
  type ReplyClassState,
} from '../questions/reply-class';
import { redactClipped } from './common';

export interface ReplyClassInput {
  accountId: string;
  /** The broadcast as the customer saw it (rendered when possible). */
  campaignMessage: string;
  /** The customer's reply: typed text, or the tapped button's title. */
  reply: string;
  /** The tapped button's title, when the reply was a tap. */
  tappedButton?: string | null;
  /** Hard deadline for the whole call, retries included. Default 2500 ms. */
  deadlineMs?: number;
}

export type ReplyClassJudgment =
  | { ok: true; cls: ReplyClass; p: number; latencyMs: number }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: the answer came from another
       *  model than the pinned one the thresholds assume. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const REPLY_CLASS_DEADLINE_MS = 2500;
const MAX_CAMPAIGN_CHARS = 1500;
const MAX_REPLY_CHARS = 1000;
const MAX_BUTTON_CHARS = 200;

/** Redacted TypeSafe state for the reply-class judgment. */
export function buildReplyClassState(
  input: Pick<ReplyClassInput, 'campaignMessage' | 'reply' | 'tappedButton'>
): ReplyClassState {
  const button = input.tappedButton?.trim();
  return {
    campaign_message: redactClipped(input.campaignMessage, MAX_CAMPAIGN_CHARS),
    reply: redactClipped(input.reply, MAX_REPLY_CHARS),
    tapped_button: button ? redactClipped(button, MAX_BUTTON_CHARS) : null,
  };
}

export async function runReplyClass(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: ReplyClassInput
): Promise<ReplyClassJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const res = await deps.gateway.ask(
    'reply_class',
    buildReplyClassState(input),
    REPLY_CLASS_QUESTIONS,
    input.accountId,
    { deadlineMs: input.deadlineMs ?? REPLY_CLASS_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const a = res.result.answers.reply_class;
  const cls = a.choice as ReplyClass;
  const probs = (a as { probabilities?: Partial<Record<ReplyClass, number>> })
    .probabilities;
  return {
    ok: true,
    cls,
    p: probs?.[cls] ?? a.confidence,
    latencyMs: res.latencyMs,
  };
}
