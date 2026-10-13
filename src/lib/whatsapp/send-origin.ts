// Where a dashboard send's text came from, when the server must know.
// Pure and client-safe: the inbox composer and `/api/whatsapp/send` both
// read it.

/**
 * `missed_call_draft`: the missed-call WhatsApp draft (module 015),
 * which plan 015 §7.4 sends "through the consent register". A send with
 * no origin is an ordinary typed reply, and the register does not gate
 * those.
 */
export const SEND_ORIGINS = ['missed_call_draft'] as const;
export type SendOrigin = (typeof SEND_ORIGINS)[number];

export function isSendOrigin(value: unknown): value is SendOrigin {
  return (SEND_ORIGINS as readonly unknown[]).includes(value);
}

/** Why the consent register refuses a message to a customer. */
export type ConsentRefusal = 'do_not_contact' | 'opted_out';

/**
 * The register's answer for a contact: do-not-contact (migration 086)
 * before opted out (076), or null when neither is set.
 */
export function consentRefusal(
  contact:
    | { do_not_contact_at?: string | null; opted_out_at?: string | null }
    | null
    | undefined
): ConsentRefusal | null {
  if (contact?.do_not_contact_at) return 'do_not_contact';
  if (contact?.opted_out_at) return 'opted_out';
  return null;
}

/**
 * The route's `{ error }` for a refusal. The inbox shows its own en/ko
 * wording, keyed on the code; this is for logs and any other caller.
 */
export const CONSENT_REFUSAL_MESSAGES: Record<ConsentRefusal, string> = {
  do_not_contact:
    'This customer is marked do-not-contact, so the message was not sent.',
  opted_out:
    'This customer has opted out of messages, so the message was not sent.',
};
