/**
 * Reminder suggestions (migration 197, lib/reminders/suggest.ts): does a
 * chat message name a later time at which someone at the business should
 * be reminded to act, what is the action about, and — when the message
 * names more than one time — which of them is meant.
 *
 * Not a safety check — no account switch, policy or ts_decision_log row.
 * The times are found deterministically (lib/reminders/time-phrases.ts);
 * Jev only chooses among them, keyed by ordinal (`t1 … tN`), never by an
 * id. State carries no ids and no names.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new REMINDER_QS_VERSION.
 */
import { choice } from '@typesafe-ai/sdk';
import { redactClipped } from '../checks/common';

export const REMINDER_QS_VERSION = 'qs-reminder-v1';

/** Times offered in one request; the caller passes at most this many. */
export const REMINDER_MAX_TIMES = 4;
export const REMINDER_MAX_TIME_CHARS = 80;

export const REMINDER_ANSWERS = {
  yes: 'yes: it names a later time for a call, payment, document, meeting, visit, answer or other action',
  no: 'no: the time is mentioned only in passing, is in the past, describes opening hours or general delivery times, or nothing needs doing then',
} as const;

/** Keys equal REMINDER_KINDS (lib/reminders/types.ts), in that order. */
export const REMINDER_KIND_OPTIONS = {
  call: 'a phone call or call back',
  documents: 'sending, collecting or receiving documents, papers or statements',
  payment: 'a payment, salary, transfer, fee or instalment',
  meeting: 'a meeting, visit or appointment',
  follow_up: 'any other follow-up, answer, update or action',
} as const;

const REMINDER_QUESTION = choice(
  '`message` is one WhatsApp message in a chat between a business and its customer; `author` says who wrote it. Does the message ask for, promise, plan or agree to something that should happen at a later time named in the message, so that someone at the business should be reminded to act or check at that time?',
  REMINDER_ANSWERS
);

const KIND_QUESTION = choice(
  'What is the action at that later time about?',
  REMINDER_KIND_OPTIONS
);

function whenQuestion(times: string[]) {
  const options: Record<string, string> = {};
  times.forEach((t, k) => {
    options[`t${k + 1}`] =
      `the time written as "${redactClipped(t, REMINDER_MAX_TIME_CHARS)}"`;
  });
  return choice(
    '`times` lists the times the message names, in order. Which one is the time for that action?',
    options
  );
}

/**
 * `reminder` and `kind` always; `when` only for 2+ times, its option
 * `t(k+1)` naming `times[k]`.
 */
export function buildReminderQuestions(times: string[]) {
  const shown = times.slice(0, REMINDER_MAX_TIMES);
  return {
    reminder: REMINDER_QUESTION,
    kind: KIND_QUESTION,
    ...(shown.length >= 2 ? { when: whenQuestion(shown) } : {}),
  };
}

export interface ReminderState {
  message: string;
  author: 'customer' | 'business';
  times: string[];
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
