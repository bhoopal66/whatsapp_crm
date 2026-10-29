/**
 * Meaning triggers (lib/insights/meaning.ts): does the customer's message
 * mean what an admin described for a Flow's `intent` trigger or an
 * automation's `intent_match` trigger? One noul per candidate, all in one
 * request.
 *
 * Not a safety check — no account switch, policy or ts_decision_log row.
 * The descriptions and examples are admin-written, so they are redacted
 * and clipped here like any other text (the gateway's PII guard reads the
 * questions too). Candidates are keyed by ordinal (`c1 … cN`), never by a
 * database id, which can trip that guard.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new INTENT_MATCH_QS_VERSION.
 */
import { noul } from '@typesafe-ai/sdk';
import { redactClipped } from '../checks/common';

export const INTENT_MATCH_QS_VERSION = 'qs-intent-match-v1';

/** Candidates judged in one request; the rest are dropped. */
export const INTENT_MAX_CANDIDATES = 20;
export const INTENT_MAX_DESCRIPTION_CHARS = 300;
export const INTENT_MAX_EXAMPLES = 5;
export const INTENT_MAX_EXAMPLE_CHARS = 120;

export interface IntentCandidateText {
  description: string;
  examples?: string[];
}

function intentQuestion(c: IntentCandidateText) {
  const description = redactClipped(
    c.description.trim(),
    INTENT_MAX_DESCRIPTION_CHARS
  );
  const examples = (c.examples ?? [])
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, INTENT_MAX_EXAMPLES)
    .map((e) => `"${redactClipped(e, INTENT_MAX_EXAMPLE_CHARS)}"`);
  const tail = examples.length
    ? ` Messages that mean this include: ${examples.join(', ')}.`
    : '';
  return noul(
    `Does the customer in \`message\` mean the following? ${description}${tail} Use \`recent_turns\` only to understand what \`message\` refers to.`,
    {
      true: 'The message means this, in any wording or language.',
      false: 'It means something else, or only mentions the topic in passing.',
    }
  );
}

export type IntentQuestion = ReturnType<typeof intentQuestion>;

/** `{ c1 … cN }`: `c(k+1)` judges `candidates[k]`; `keys` in that order. */
export function buildIntentQuestions(candidates: IntentCandidateText[]): {
  questions: Record<string, IntentQuestion>;
  keys: string[];
} {
  const questions: Record<string, IntentQuestion> = {};
  const keys: string[] = [];
  candidates.slice(0, INTENT_MAX_CANDIDATES).forEach((c, k) => {
    const key = `c${k + 1}`;
    questions[key] = intentQuestion(c);
    keys.push(key);
  });
  return { questions, keys };
}

export interface IntentMatchState {
  message: string;
  recent_turns: { from: 'customer' | 'business'; text: string }[];
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
