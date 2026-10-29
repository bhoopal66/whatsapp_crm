/**
 * Message check before sending (docs/jev-insights.md): what an agent's
 * draft WhatsApp message may say that a UAE credit broker should not.
 * Not a safety check — it warns a person, never blocks a send, and is
 * never logged to ts_decision_log.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new COMPOSE_CHECK_QS_VERSION.
 */
import { noul } from '@typesafe-ai/sdk';

export const COMPOSE_CHECK_QS_VERSION = 'qs-compose-check-v1';

const CONTEXT =
  'Use `recent_turns` only to understand what `draft` refers to; judge only what `draft` itself says.';

/** Asked of every draft. */
export const COMPOSE_CHECK_QUESTIONS = {
  promise: noul(
    `Does \`draft\`, a message the business is about to send to a customer, say or imply that the customer's application will be approved? ${CONTEXT}`,
    {
      true: 'The draft says or implies that an application will be approved, that approval is guaranteed, or that it will be approved within a stated time.',
      false:
        'The draft describes the process, asks for information or documents, or says the bank makes the decision, without saying the application will be approved.',
    }
  ),
  terms: noul(
    `Does \`draft\` quote a specific interest or profit rate, fee or loan amount as an offer to this customer? ${CONTEXT}`,
    {
      true: 'The draft states a specific interest rate, profit rate, fee or loan amount that the customer is offered or will get.',
      false:
        'The draft states no specific rate, fee or amount as an offer. Saying that rates vary, or asking the customer for their own figures, is not an offer.',
    }
  ),
  secrets: noul(
    `Does \`draft\` ask the customer to send secret financial or login details? ${CONTEXT}`,
    {
      true: 'The draft asks the customer to send a full card number, a CVV, a PIN, a one-time password (OTP), a password or an online-banking login.',
      false:
        'The draft asks for none of these. Asking for documents such as a salary certificate, a passport or bank statements is not asking for them.',
    }
  ),
  tone: noul(
    `Is \`draft\` rude, dismissive, aggressive or inappropriate toward the customer? ${CONTEXT}`,
    {
      true: 'The draft is rude, dismissive, aggressive or inappropriate toward the customer.',
      false:
        'The draft is polite or neutral, even when it is short or declines a request.',
    }
  ),
} as const;

/** Asked only when the draft would start a conversation on a linked-device
 *  number: WhatsApp restricts numbers that send unsolicited marketing. */
export const COMPOSE_CHECK_START_QUESTIONS = {
  ...COMPOSE_CHECK_QUESTIONS,
  cold_pitch: noul(
    'Does `draft`, the first message in this conversation for at least a day, read like an unsolicited bulk marketing message rather than a personal message?',
    {
      true: 'The draft reads like a generic advertisement or promotion that could be sent unchanged to many people who did not ask for it.',
      false:
        'The draft reads like a personal message to this customer, such as a follow-up on something they asked about or a reply to them.',
    }
  ),
} as const;

export type ComposeCheckQuestion = keyof typeof COMPOSE_CHECK_START_QUESTIONS;

/** The question set for one draft: `cold_pitch` only when it starts a chat. */
export function composeCheckQuestions(isStart: boolean) {
  return isStart ? COMPOSE_CHECK_START_QUESTIONS : COMPOSE_CHECK_QUESTIONS;
}

export interface ComposeCheckState {
  draft: string;
  recent_turns: { from: 'customer' | 'business'; text: string }[];
  is_start: boolean;
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
