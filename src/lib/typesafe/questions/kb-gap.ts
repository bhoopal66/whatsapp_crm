/**
 * Knowledge-gap topics (lib/kb/gap-recompute.ts): what a question the
 * bot could not answer is about, and whether one of the approved answers
 * shortlisted for it already answers it. One request per topic: the
 * intent question plus one coverage question per candidate answer.
 *
 * Not a safety check — no account switch, policy or ts_decision_log row.
 * The intents are triage's own (questions/triage.ts), imported rather
 * than copied, so a topic's intent and a message's triage intent mean the
 * same thing.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here — or triage's INTENTS — means a new
 * KB_GAP_QS_VERSION.
 */
import { choice, score } from '@typesafe-ai/sdk';
import { INTENTS } from './triage';

export const KB_GAP_QS_VERSION = 'qs-kb-gap-v1';

export const KB_GAP_INTENT_QUESTIONS = {
  intent: choice('What is the customer asking about in `question`?', INTENTS),
} as const;

/** The coverage question for the k-th answer (0-based), by path. */
function coverageQuestion(k: number) {
  const path = `\`answers[${k}].text\``;
  return score(
    `How much of \`question\` does the approved answer in ${path} answer?`,
    [
      `The approved answer in ${path} does not answer \`question\`.`,
      `The approved answer in ${path} answers part of \`question\`.`,
      `The approved answer in ${path} fully answers \`question\`.`,
    ]
  );
}

export type KbGapCoverageQuestion = ReturnType<typeof coverageQuestion>;

/** `{ c1 … cn }`: `c(k+1)` judges `answers[k]`. */
export function buildCoverageQuestions(
  n: number
): Record<string, KbGapCoverageQuestion> {
  const out: Record<string, KbGapCoverageQuestion> = {};
  for (let k = 0; k < n; k++) out[`c${k + 1}`] = coverageQuestion(k);
  return out;
}

export interface KbGapState {
  question: string;
  /** Text only — no entry id or ref (the PII guard refuses UUIDs).
   *  Mapped back by position on our side. */
  answers: { text: string }[];
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
