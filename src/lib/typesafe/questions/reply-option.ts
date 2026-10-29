/**
 * Typed answers to buttons and lists (lib/flows/typed-reply-judge.ts):
 * which of the options a flow offered does the customer's typed reply
 * choose? One choice over `o1 … oN` plus `none`.
 *
 * Not a safety check — no account switch, policy or ts_decision_log row.
 * Option labels are author-written, so they are redacted and clipped
 * like any other text (the gateway's PII guard reads the questions too).
 * Options are keyed by ordinal, never by a node key or reply id.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new REPLY_OPTION_QS_VERSION.
 */
import { choice } from '@typesafe-ai/sdk';
import { redactClipped } from '../checks/common';

export const REPLY_OPTION_QS_VERSION = 'qs-reply-option-v1';

/** WhatsApp caps a list at 10 rows and buttons at 3; the rest are dropped. */
export const REPLY_OPTION_MAX_OPTIONS = 10;
export const REPLY_OPTION_MAX_LABEL_CHARS = 200;

export const REPLY_OPTION_NONE =
  "The reply doesn't choose any of these options, or asks something else.";

export interface ReplyOptionText {
  title: string;
  description?: string;
}

function optionCriterion(o: ReplyOptionText): string {
  const title = redactClipped(o.title.trim(), REPLY_OPTION_MAX_LABEL_CHARS);
  const description = o.description?.trim()
    ? redactClipped(o.description.trim(), REPLY_OPTION_MAX_LABEL_CHARS)
    : '';
  return description
    ? `The option "${title}" (${description}).`
    : `The option "${title}".`;
}

/** `keys[k]` is the label of `options[k]` (`o(k+1)`); `none` is extra. */
export function buildReplyOptionQuestions(options: ReplyOptionText[]) {
  const criteria: Record<string, string> = {};
  const keys: string[] = [];
  options.slice(0, REPLY_OPTION_MAX_OPTIONS).forEach((o, k) => {
    const key = `o${k + 1}`;
    criteria[key] = optionCriterion(o);
    keys.push(key);
  });
  criteria.none = REPLY_OPTION_NONE;
  return {
    questions: {
      option: choice(
        "Which of the offered options does the customer's reply in `message` choose? `prompt` is the question the business asked.",
        criteria
      ),
    },
    keys,
  };
}

export interface ReplyOptionState {
  /** The node's body text: the question the customer was asked. */
  prompt: string;
  /** The customer's typed reply. */
  message: string;
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
