/**
 * Smart insights judgment (docs/jev-insights.md): one TypeSafe request per
 * inbound customer turn, answering the customer signals (unless the bot's
 * or the watch's triage already judged this exact message — the caller
 * then passes `askSignals: false`) and a chat-tag suggestion over the
 * workspace's own tags.
 *
 * Not a safety check: no account switch, policy or decision-log row. It
 * goes through the same gateway — PII guard, size budget, its own
 * `insights` breaker, never throws — and only for accounts the install
 * allows (TS_ACCOUNT_IDS). It runs off the reply path, hence the longer
 * default deadline. A failure is `{ ok: false }` and stores nothing.
 */
import type { ChoiceResponse, Questions } from '@typesafe-ai/sdk';
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import type { Intent } from '../questions/triage';
import {
  NONE_OPTION,
  SIGNAL_QUESTIONS,
  TAG_QUESTION_KEY,
  buildTagQuestions,
  type InsightsState,
  type TagCatalogue,
} from '../questions/insights';
import { redactClipped } from './common';

export interface InsightsInput {
  accountId: string;
  /** Everything the customer wrote in this turn. */
  message: string;
  recentTurns?: { from: 'customer' | 'taamul'; text: string }[];
  journeyStage?: string;
  /** false when triage already answered the signals for this message. */
  askSignals: boolean;
  /** The workspace's tags when tag suggestions are on; else null/absent. */
  tags?: TagCatalogue | null;
  /** Hard deadline for the whole call, retries included. Default 4000 ms. */
  deadlineMs?: number;
}

export interface InsightsSignals {
  intent: { key: Intent; p: number };
  /** Expected urgency level, 0..2 (the triage `urgency` scale). */
  urgency: number;
  /** Expected lead temperature, 0..3 (the triage `lead_temperature` scale). */
  leadTemp: number;
  /** P(the customer expresses dissatisfaction). */
  upset: number;
  /** P(the customer asks for a person). */
  wantsHuman: number;
}

export interface TagSuggestion {
  /** null when Jev chose `none`. */
  mainId: string | null;
  /** Probability of the chosen `chat_tag` option (`none` included). */
  mainP: number;
  /** null when no sub-tag question was asked for the chosen main tag, or
   *  its answer was `none`. */
  subId: string | null;
  /** Probability of the chosen sub-tag option (`none` included); null
   *  when no sub-tag question was asked for the chosen main tag. */
  subP: number | null;
}

export type InsightsJudgment =
  | {
      ok: true;
      /** null when `askSignals` was false. */
      signals: InsightsSignals | null;
      /** null when no tag catalogue (or an empty one) was given. */
      tag: TagSuggestion | null;
      latencyMs: number;
    }
  | {
      ok: false;
      /** A gateway error, or MODEL_MISMATCH: the answer came from another
       *  model than the pinned one the bands assume. */
      errorCode: ErrorCode | 'MODEL_MISMATCH';
      latencyMs: number;
    };

export const INSIGHTS_DEADLINE_MS = 4000;
const MAX_TURNS = 6;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TURN_CHARS = 1000;
/** What `journey_stage` says when the caller has none. */
const UNKNOWN_STAGE = 'unknown';

/** Redacted TypeSafe state for the insights judgment. */
export function buildInsightsState(
  input: Pick<InsightsInput, 'message' | 'recentTurns' | 'journeyStage'>
): InsightsState {
  return {
    message: redactClipped(input.message, MAX_MESSAGE_CHARS, { tail: true }),
    recent_turns: (input.recentTurns ?? []).slice(-MAX_TURNS).map((t) => ({
      from: t.from,
      text: redactClipped(t.text, MAX_TURN_CHARS),
    })),
    journey_stage: input.journeyStage ?? UNKNOWN_STAGE,
  };
}

/** P(the chosen option), with the confidence fallback for an answer
 *  without per-option probabilities. */
const chosenP = (a: ChoiceResponse): number =>
  (a.probabilities as Partial<Record<string, number>> | undefined)?.[
    a.choice
  ] ?? a.confidence;

export async function runInsights(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: InsightsInput
): Promise<InsightsJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const tagged =
    input.tags && input.tags.mains.length > 0
      ? buildTagQuestions(input.tags)
      : null;
  if (!input.askSignals && !tagged)
    return { ok: true, signals: null, tag: null, latencyMs: 0 };

  const questions: Questions = {
    ...(input.askSignals ? SIGNAL_QUESTIONS : {}),
    ...(tagged?.questions ?? {}),
  };
  const res = await deps.gateway.ask(
    'insights',
    buildInsightsState(input),
    questions,
    input.accountId,
    { deadlineMs: input.deadlineMs ?? INSIGHTS_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const a = res.result.answers as Record<
    string,
    ChoiceResponse | { score: number } | { noul: number }
  >;

  let signals: InsightsSignals | null = null;
  if (input.askSignals) {
    const intent = a.intent as ChoiceResponse;
    signals = {
      intent: { key: intent.choice as Intent, p: chosenP(intent) },
      urgency: (a.urgency as { score: number }).score,
      leadTemp: (a.lead_temperature as { score: number }).score,
      upset: (a.dissatisfied as { noul: number }).noul,
      wantsHuman: (a.wants_human as { noul: number }).noul,
    };
  }

  let tag: TagSuggestion | null = null;
  if (tagged) {
    const main = a[TAG_QUESTION_KEY] as ChoiceResponse;
    const mainId =
      main.choice === NONE_OPTION
        ? null
        : (tagged.keyMap.mains[main.choice] ?? null);
    tag = { mainId, mainP: chosenP(main), subId: null, subP: null };
    // Only the chosen main tag's sub-tag question counts: the others were
    // asked on a premise that turned out false.
    const sub = mainId ? tagged.keyMap.subs[main.choice] : undefined;
    const subAnswer = sub ? (a[sub.question] as ChoiceResponse) : undefined;
    if (sub && subAnswer) {
      tag.subId =
        subAnswer.choice === NONE_OPTION
          ? null
          : (sub.options[subAnswer.choice] ?? null);
      tag.subP = chosenP(subAnswer);
    }
  }

  return { ok: true, signals, tag, latencyMs: res.latencyMs };
}
