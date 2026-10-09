/**
 * Model-tier routing (lib/ai/router.ts): what kind of reply the
 * customer's latest message needs, so a greeting is answered by a small
 * model and a negotiation by a large one. Not a safety check — it is
 * never logged to ts_decision_log and has no account switch.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new ROUTE_QS_VERSION.
 */
import { choice, noul, score } from '@typesafe-ai/sdk';

export const ROUTE_QS_VERSION = 'qs-route-v1';

export const ROUTE_KINDS = {
  greeting_or_thanks:
    'The message is only a greeting, thanks, an acknowledgement or an emoji.',
  simple_question:
    'The message is one straightforward question or request that can be answered in a sentence or two.',
  detailed_question:
    'Answering the message needs an explanation of a process, a product or several facts.',
  multi_part_or_reasoning:
    'The message asks several questions, asks for a comparison or a calculation, or needs careful reasoning.',
  sensitive_or_negotiation:
    'The message is a complaint, a dispute, a negotiation over price or terms, or an emotionally charged message.',
  unclear:
    'There is not enough in the message to tell what the customer wants.',
} as const;

export type RouteKind = keyof typeof ROUTE_KINDS;

export const ROUTE_QUESTIONS = {
  kind: choice(
    'What kind of message is `message`? Use `recent_turns` and `journey_stage` only to understand what `message` refers to.',
    ROUTE_KINDS
  ),
  complexity: score(
    'How much does a good reply to `message` need to contain?',
    [
      'No information is needed, such as for a greeting or thanks.',
      'One simple fact.',
      'Several facts, or an explanation of a process.',
      'Careful reasoning, a comparison, or careful handling of a delicate situation.',
    ]
  ),
  needs_business_facts: noul(
    "Does answering `message` need specific facts about the business's products, prices, process, documents or policies?",
    {
      true: 'A good reply has to state at least one such fact about the business.',
      false:
        'A good reply needs no such fact, such as a reply to a greeting or thanks.',
    }
  ),
} as const;

export interface RouteState {
  message: string;
  recent_turns: { from: 'customer' | 'business'; text: string }[];
  journey_stage: string;
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
