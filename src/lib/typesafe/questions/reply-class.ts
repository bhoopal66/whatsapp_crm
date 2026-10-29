/**
 * Campaign reply sorting (docs/jev-insights.md, "Campaign reply
 * sorting"): how a customer's first reply to a broadcast responds to it.
 * Not a safety check — "stop" is display-only here; the opt-out watch
 * (lib/ai/typesafe-watch.ts) is what marks a contact opted out.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new REPLY_CLASS_QS_VERSION.
 */
import { choice } from '@typesafe-ai/sdk';

export const REPLY_CLASS_QS_VERSION = 'qs-reply-class-v1';

export const REPLY_CLASSES = {
  interested:
    'wants the offer, asks to go ahead, asks how to apply, or asks to be contacted about it',
  question: 'asks a question about the offer before deciding',
  not_now: 'may be interested later but not now',
  not_interested: 'declines the offer but does not ask to stop all messages',
  wrong_person:
    "the message reached the wrong person, or they say they never asked for it or don't know the business",
  stop: 'asks to stop messages, unsubscribe or not be contacted again',
  other:
    'anything else, such as a greeting, an acknowledgement or an unrelated message',
} as const;

export type ReplyClass = keyof typeof REPLY_CLASSES;

/** In 148's CHECK order. */
export const REPLY_CLASS_NAMES = Object.keys(REPLY_CLASSES) as ReplyClass[];

export const REPLY_CLASS_QUESTIONS = {
  reply_class: choice(
    "The business sent the broadcast in `campaign_message`. How does the customer's reply in `reply` respond to it? `tapped_button` is the button the customer tapped, if any.",
    REPLY_CLASSES
  ),
} as const;

export interface ReplyClassState {
  campaign_message: string;
  reply: string;
  tapped_button: string | null;
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
