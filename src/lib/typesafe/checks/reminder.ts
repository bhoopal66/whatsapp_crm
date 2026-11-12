/**
 * Reminder suggestion judgment (lib/reminders/suggest.ts): one TypeSafe
 * request that says whether a chat message names a later time someone
 * should be reminded of, what the action is about, and which of the
 * message's times is meant.
 *
 * Not a safety check, so it ignores the account's switches
 * (ts_account_settings), reads no policy and writes no decision-log row.
 * It still goes through the same gateway — PII guard, size budget, its
 * own `reminder` breaker, never throws — and only runs for accounts the
 * install allows (TS_ACCOUNT_IDS) on an install with an API key. A
 * failure is `{ ok: false }`, and no suggestion is stored.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  buildReminderQuestions,
  REMINDER_MAX_TIMES,
  REMINDER_MAX_TIME_CHARS,
  type ReminderState,
} from '../questions/reminder';
import type { ReminderKind, ReminderSide } from '@/lib/reminders/types';
import { redactClipped } from './common';

export interface ReminderJudgmentInput {
  accountId: string;
  /** The chat message. */
  text: string;
  /** Who wrote it. */
  side: ReminderSide;
  /** The time phrases the message names, in order (1..4 are used). */
  times: string[];
  /** Hard deadline for the whole call, retries included. Default 4000 ms. */
  deadlineMs?: number;
}

export type ReminderJudgment =
  | {
      ok: true;
      isReminder: boolean;
      /** P(yes): something to be reminded of. */
      p: number;
      /** Index into `times` of the time meant (0 with a single time). */
      timeIndex: number;
      kind: ReminderKind;
      latencyMs: number;
    }
  | {
      ok: false;
      /** A gateway error, NO_TIMES, or MODEL_MISMATCH: the answer came
       *  from another model than the pinned one the threshold assumes. */
      errorCode: ErrorCode | 'MODEL_MISMATCH' | 'NO_TIMES';
      latencyMs: number;
    };

export const REMINDER_DEADLINE_MS = 4000;
const MAX_MESSAGE_CHARS = 1000;

/** Redacted TypeSafe state for the reminder judgment. */
export function buildReminderState(
  input: Pick<ReminderJudgmentInput, 'text' | 'side' | 'times'>
): ReminderState {
  return {
    message: redactClipped(input.text, MAX_MESSAGE_CHARS),
    author: input.side === 'customer' ? 'customer' : 'business',
    times: input.times
      .slice(0, REMINDER_MAX_TIMES)
      .map((t) => redactClipped(t, REMINDER_MAX_TIME_CHARS)),
  };
}

export async function runReminderJudgment(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: ReminderJudgmentInput
): Promise<ReminderJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const times = input.times.slice(0, REMINDER_MAX_TIMES);
  if (times.length === 0)
    return { ok: false, errorCode: 'NO_TIMES', latencyMs: 0 };
  const res = await deps.gateway.ask(
    'reminder',
    buildReminderState({ ...input, times }),
    buildReminderQuestions(times),
    input.accountId,
    { deadlineMs: input.deadlineMs ?? REMINDER_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const answers = res.result.answers as unknown as Record<
    string,
    | {
        choice?: string;
        confidence?: number;
        probabilities?: Record<string, number>;
      }
    | undefined
  >;
  const r = answers.reminder;
  const isReminder = r?.choice === 'yes';
  const pYes =
    r?.probabilities?.yes ??
    (typeof r?.confidence === 'number'
      ? isReminder
        ? r.confidence
        : 1 - r.confidence
      : 0);
  const p = Number.isFinite(pYes) ? Math.max(0, Math.min(1, pYes)) : 0;
  const kind = (answers.kind?.choice ?? 'follow_up') as ReminderKind;
  let timeIndex = 0;
  if (times.length >= 2) {
    const m = /^t(\d+)$/.exec(answers.when?.choice ?? '');
    const k = m ? Number(m[1]) - 1 : -1;
    if (k < 0 || k >= times.length)
      return { ok: false, errorCode: 'BAD_RESPONSE', latencyMs: res.latencyMs };
    timeIndex = k;
  }
  return { ok: true, isReminder, p, timeIndex, kind, latencyMs: res.latencyMs };
}
