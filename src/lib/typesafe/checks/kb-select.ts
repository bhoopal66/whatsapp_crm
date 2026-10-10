/**
 * Approved-answers selection (module 017): Jev judges each shortlisted
 * approved answer against the customer's message, plus three hand-off
 * conditions. lib/kb/select-policy.ts turns the figures into "send this
 * approved answer verbatim" or "hand off".
 *
 * A SELECTION judgment, not a safety check — like checks/route.ts it
 * ignores the account's switches (ts_account_settings), reads no policy
 * and writes no decision-log row. It still goes through the same gateway
 * (PII guard, size budget, its own `kb_select` breaker), never throws,
 * and only runs for accounts the install allows (TS_ACCOUNT_IDS) on an
 * install with an API key.
 *
 * Fail-safe: any request failing, or any answer from another model than
 * the pinned one, makes the whole judgment `{ ok: false }` and the caller
 * hands off. Half a judgment (candidates without the hand-off batch, or
 * the reverse) is never returned.
 */
import { accountEnabled } from '../config';
import type { CallResult, ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  KB_CANDIDATE_QUESTIONS,
  KB_HANDOFF_QUESTIONS,
  type KbCandidateState,
  type KbHandoffState,
  type KbTurn,
} from '../questions/kb-select';
import { mapLimit, redactClipped } from './common';

export interface KbSelectInput {
  accountId: string;
  /** Everything the customer wrote since the bot last spoke. */
  message: string;
  recentTurns?: KbTurn[];
  /** The shortlist, best lexical match first. Only the text goes to
   *  TypeSafe; results come back by position in this array. */
  candidates: { question: string; answer: string }[];
  /** Hard deadline for every request together, retries included.
   *  Default KB_SELECT_DEADLINE_MS. */
  deadlineMs?: number;
}

export type KbSelectJudgment =
  | {
      ok: true;
      /** P(each hand-off condition). */
      handoff: { pricing: number; legal: number; angry: number };
      /** One per judged candidate; `index` is its position in the input. */
      candidates: { index: number; answersFully: number; sameIntent: number }[];
      latencyMs: number;
    }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: an answer came from another
       *  model than the pinned one the policy's thresholds assume. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const KB_SELECT_DEADLINE_MS = 6000;
export const KB_SELECT_CONCURRENCY = 4;
/** The shortlist is at most this long; extra rows are not judged. */
export const KB_SELECT_MAX_CANDIDATES = 8;
const MAX_TURNS = 6;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TURN_CHARS = 1000;
const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 3000;

/** Redacted state shared by every request: the message and its context. */
export function buildKbHandoffState(
  input: Pick<KbSelectInput, 'message' | 'recentTurns'>
): KbHandoffState {
  return {
    message: redactClipped(input.message, MAX_MESSAGE_CHARS, { tail: true }),
    recent_turns: (input.recentTurns ?? []).slice(-MAX_TURNS).map((t) => ({
      from: t.from,
      text: redactClipped(t.text, MAX_TURN_CHARS),
    })),
  };
}

/** Redacted state for one candidate. Text only: no id, no ref. */
export function buildKbCandidateState(
  base: KbHandoffState,
  candidate: { question: string; answer: string }
): KbCandidateState {
  return {
    ...base,
    candidate: {
      question: redactClipped(candidate.question, MAX_QUESTION_CHARS),
      answer: redactClipped(candidate.answer, MAX_ANSWER_CHARS),
    },
  };
}

type Job =
  | { kind: 'handoff' }
  | { kind: 'candidate'; index: number; state: KbCandidateState };

type JobResult =
  | CallResult<typeof KB_HANDOFF_QUESTIONS>
  | CallResult<typeof KB_CANDIDATE_QUESTIONS>;

export async function runKbSelect(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: KbSelectInput
): Promise<KbSelectJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };

  const started = Date.now();
  const deadline = started + (input.deadlineMs ?? KB_SELECT_DEADLINE_MS);
  const base = buildKbHandoffState(input);
  const jobs: Job[] = [
    { kind: 'handoff' },
    ...input.candidates
      .slice(0, KB_SELECT_MAX_CANDIDATES)
      .map((c, index): Job => ({
        kind: 'candidate',
        index,
        state: buildKbCandidateState(base, c),
      })),
  ];

  // One failure already decides the outcome, so requests still queued
  // behind it are not sent.
  let failed = false;
  const results = await mapLimit(
    jobs,
    KB_SELECT_CONCURRENCY,
    async (job): Promise<JobResult | null> => {
      if (failed) return null;
      const left = deadline - Date.now();
      if (left <= 0) {
        failed = true;
        return {
          ok: false,
          errorCode: 'TIMEOUT',
          latencyMs: 0,
          message: 'kb_select deadline',
        };
      }
      const res =
        job.kind === 'handoff'
          ? await deps.gateway.ask(
              'kb_select',
              base,
              KB_HANDOFF_QUESTIONS,
              input.accountId,
              { deadlineMs: left }
            )
          : await deps.gateway.ask(
              'kb_select',
              job.state,
              KB_CANDIDATE_QUESTIONS,
              input.accountId,
              { deadlineMs: left }
            );
      if (!res.ok || res.modelMismatch) failed = true;
      return res;
    }
  );
  const latencyMs = Date.now() - started;

  // First failure in job order names the error; a skipped job only
  // exists behind a failure.
  for (const res of results) {
    if (res && !res.ok)
      return { ok: false, errorCode: res.errorCode, latencyMs };
  }
  if (results.some((r) => r?.ok && r.modelMismatch))
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs };

  // Every job answered: jobs[0] is the hand-off batch, the rest are the
  // candidates in input order.
  type Answered<
    Q extends typeof KB_HANDOFF_QUESTIONS | typeof KB_CANDIDATE_QUESTIONS,
  > = Extract<CallResult<Q>, { ok: true }>;
  const [first, ...rest] = results;
  const h = (first as Answered<typeof KB_HANDOFF_QUESTIONS>).result.answers;
  const handoff = {
    pricing: h.pricing_request.noul,
    legal: h.legal_regulatory.noul,
    angry: h.angry_tone.noul,
  };
  const candidates = rest.map((res, index) => {
    const a = (res as Answered<typeof KB_CANDIDATE_QUESTIONS>).result.answers;
    return {
      index,
      answersFully: a.answers_fully.noul,
      sameIntent: a.same_intent.noul,
    };
  });
  return { ok: true, handoff, candidates, latencyMs };
}
