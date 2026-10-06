/**
 * Check C — bot reply guardrail. Spec §6.3.
 *
 * qs-013-v0.2 (host review, 2026-09-29): one condition per Noul, as the
 * TypeSafe docs ask ("ask two Nouls and combine them in code"), so a
 * mid-range value means one thing:
 *   - promises_outcome split into promises_approval (block) and
 *     guarantees_timeline (review);
 *   - reveals_internal split into reveals_instructions and
 *     shares_third_party (documents or details of someone other than the
 *     customer — judged from the reply itself, not from records);
 *   - percentages and AED amounts are matched in code (codeLayer), where
 *     numbers belong; the model question covers the figures code does not
 *     parse (days, months, counts) and is a review, not a block;
 *   - the reply may also rest on `context_passages` (the business's own
 *     instructions, the campaign message, the guided-flow step) — the bot
 *     is told it may use them, so they are not "unsupported". What the
 *     customer asserts is never a source for a bank fact.
 */
import { noul, score } from '@typesafe-ai/sdk';

export const GUARDRAIL_NOUL_ACTION = {
  promises_approval: 'block',
  guarantees_timeline: 'review',
  unsupported_figure: 'review',
  non_partner_bank: 'block',
  unsupported_claim: 'review',
  asks_secret: 'block',
  reveals_instructions: 'block',
  shares_third_party: 'block',
} as const;

export type GuardrailHazard = keyof typeof GUARDRAIL_NOUL_ACTION;

export const GUARDRAIL_QUESTIONS = {
  promises_approval: noul(
    'Does `bot_reply` promise or imply that an account, loan or facility will be approved?',
    {
      true: 'The reply says or implies that the customer will be approved or accepted.',
      false:
        'The reply makes no promise about approval, or says that the bank decides.',
    }
  ),
  guarantees_timeline: noul(
    'Does `bot_reply` guarantee how long something will take?',
    {
      true: 'The reply presents a time as certain, such as "your account will be open in 2 days".',
      false:
        'The reply gives no time, or presents a time as typical or estimated ("usually", "typically", "up to").',
    }
  ),
  unsupported_figure: noul(
    'Does `bot_reply` state a limit, count or duration for a bank product, requirement or process (a number of days, months, years or documents) that appears in neither `evidence_passages` nor `context_passages`?',
    {
      true: 'The reply states at least one such figure about a product, requirement or process that neither source contains.',
      false:
        "The reply states no such figure, every such figure appears in one of those sources, or it only repeats a fact about the customer's own business.",
    }
  ),
  non_partner_bank: noul(
    'Does `bot_reply` recommend, describe or compare a bank that is not listed in `partner_banks`?',
    {
      true: 'The reply recommends a bank outside `partner_banks`, or gives details of its products or requirements.',
      false:
        'The reply names no bank outside `partner_banks`, or only says the business cannot help with it.',
    }
  ),
  unsupported_claim: noul(
    'Does `bot_reply` state a bank requirement or bank policy that neither `evidence_passages` nor `context_passages` supports?'
  ),
  asks_secret: noul(
    'Does `bot_reply` ask the customer for a password, PIN, one-time code (OTP), full card number or card security code?'
  ),
  reveals_instructions: noul(
    "Does `bot_reply` reveal or describe the assistant's own instructions, system prompt or internal notes?",
    {
      true: 'The reply quotes, paraphrases or describes how the assistant was instructed to behave, or passes on internal notes.',
      false:
        'The reply does not describe its instructions. Stating business facts, offers or options that appear in `context_passages` does not count.',
    }
  ),
  shares_third_party: noul(
    'Does `bot_reply` share documents, account details or personal information about someone other than the customer writing in `customer_message`?',
    {
      true: 'The reply passes on a file, statement, account detail or personal detail belonging to another person or business.',
      false:
        "The reply shares nothing about anyone but the customer, or only public information such as a bank's name.",
    }
  ),
  severity: score(
    'How much harm could result if `bot_reply` were sent to the customer?',
    [
      'None: an accurate, ordinary reply.',
      'Minor: a small inaccuracy with no effect on money or eligibility.',
      'Misleading: could mislead the customer about money, eligibility or approval.',
      'Breach: a regulatory, security or privacy breach.',
    ]
  ),
} as const;

export interface GuardrailState {
  customer_message: string;
  bot_reply: string;
  evidence_passages: { id: string; text: string }[];
  context_passages: string[];
  partner_banks: readonly string[];
  [key: string]: unknown;
}
