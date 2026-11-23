import { redact } from '@/lib/memory/redact';
import type { ChatMessage } from './types';

/**
 * What an AI provider is shown of a chat: every turn, the customer's and
 * ours, with identifiers masked (Emirates ID, card, IBAN, account,
 * passport, OTP, phone, e-mail). The sensitive-data gate only looks at
 * the message being answered, so without this the identifier it refused
 * went to the provider on the next turn, as history.
 *
 * `lib/memory/redact.ts`, not TypeSafe's: that one also masks any long
 * digit run, and a turnover or salary written without "AED" is exactly
 * what the bot has to read.
 */

/** Stands in for text that could not be screened. */
export const WITHHELD = '[withheld]';

export function redactForProvider(text: string): string {
  const r = redact(text);
  return r.ok ? r.text : WITHHELD;
}

/**
 * Text our own side wrote for the customer to receive (what an agent
 * typed for a draft, a flow step's wording). A phone number or e-mail
 * there is the content of the message, so it stays; anything else found
 * masks the lot.
 */
export function redactOwnText(text: string): string {
  const r = redact(text);
  if (!r.ok) return WITHHELD;
  const kinds = Object.keys(r.redactions);
  return kinds.every((k) => k === 'PHONE' || k === 'EMAIL') ? text : r.text;
}

export function redactMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const own = m.agentText;
    // The last occurrence: the builder puts the agent's text after the
    // transcript, so a customer repeating it cannot stand in for it.
    const at = own ? m.content.lastIndexOf(own) : -1;
    const content =
      own && at >= 0
        ? redactForProvider(m.content.slice(0, at)) +
          redactOwnText(own) +
          redactForProvider(m.content.slice(at + own.length))
        : redactForProvider(m.content);
    return { ...m, content };
  });
}

const PLACEHOLDER =
  /\[(?:EMAIL|IBAN|EID|CARD|OTP|ACCT|PASSPORT|PHONE:\d{3}|withheld)\]/;

/** The model repeated a mask: never sendable to a customer as it is. */
export function echoesRedaction(text: string): boolean {
  return PLACEHOLDER.test(text);
}
