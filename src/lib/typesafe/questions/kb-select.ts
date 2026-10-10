/**
 * Approved-answers selection (module 017, lib/kb/select-policy.ts): Jev
 * judges each shortlisted approved Q&A row against the customer's
 * message, and three conditions that send the thread to a person no
 * matter how well an answer fits. The bot never writes text in this
 * mode; code picks one approved answer verbatim, or hands off.
 *
 * Not a safety check — no account switch, policy or ts_decision_log row.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new KB_SELECT_QS_VERSION. It is
 * independent of the 013 QS_VERSION, which approved policies name.
 */
import { noul } from '@typesafe-ai/sdk';

export const KB_SELECT_QS_VERSION = 'qs-017-v1';

/** One request per shortlisted candidate. */
export const KB_CANDIDATE_QUESTIONS = {
  answers_fully: noul(
    'Does `candidate.answer` fully answer what the customer asks in `message`? Use `recent_turns` only to understand what `message` refers to.',
    {
      true: 'Sent on its own as the reply, `candidate.answer` answers every question and request in `message`, and the customer would need to ask nothing further to get what they asked for.',
      false:
        '`candidate.answer` leaves at least one question or request in `message` unanswered, answers only part of it, answers a different question, or `message` asks nothing that `candidate.answer` addresses, such as a greeting or thanks.',
    }
  ),
  same_intent: noul(
    'Is the customer in `message` asking what `candidate.question` asks? Use `recent_turns` only to understand what `message` refers to.',
    {
      true: '`message` asks the same thing as `candidate.question`, in any wording or language, even if `message` also asks something more.',
      false:
        '`message` asks about something else, asks about a related but different product, case or detail, or asks nothing at all.',
    }
  ),
} as const;

/** One request per customer message, alongside the candidates. */
export const KB_HANDOFF_QUESTIONS = {
  pricing_request: noul(
    'Does the customer in `message` ask for a price figure, such as an interest rate, a profit rate, a fee, a charge, an MDR or a commission? Use `recent_turns` only to understand what `message` refers to.',
    {
      true: 'The customer asks what a rate, fee, charge, MDR, commission or other price is, or asks how much something costs, in any wording or language.',
      false:
        'No request for a price figure. Asking which documents are needed, how long something takes, or whether a product exists does not count.',
    }
  ),
  legal_regulatory: noul(
    'Does the customer in `message` ask a legal, regulatory, licensing or compliance question, or threaten legal action? Use `recent_turns` only to understand what `message` refers to.',
    {
      true: 'The customer asks what a law, regulation, licence or compliance rule requires or allows, asks whether something is legal, or threatens to complain to a regulator, go to court or involve a lawyer or the police.',
      false:
        'No such question or threat. Asking which documents an application needs, such as a trade licence, does not count.',
    }
  ),
  angry_tone: noul(
    'Is the tone of the customer in `message` hostile, abusive or furious? Use `recent_turns` only to understand what `message` refers to.',
    {
      true: 'The customer insults, swears at, threatens or shouts at the business or its staff, or writes in clear fury.',
      false:
        'A calm, polite or neutral tone, including mild dissatisfaction, impatience, a firm complaint or a reminder that they are still waiting.',
    }
  ),
} as const;

export interface KbTurn {
  from: 'customer' | 'business';
  text: string;
}

export interface KbHandoffState {
  message: string;
  recent_turns: KbTurn[];
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}

export interface KbCandidateState extends KbHandoffState {
  /** No id or ref: a database id can trip the PII guard. Mapped back by
   *  ordinal on our side. */
  candidate: { question: string; answer: string };
}
