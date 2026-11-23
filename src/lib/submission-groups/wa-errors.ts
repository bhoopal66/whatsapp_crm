/**
 * Reasons this module itself writes into `wa_close_error` / `wa_create_error`
 * and reads back on the screen, so they can be said in the reader's language.
 * Client-safe: no imports. The stored text is English and never holds a phone
 * number (it also goes out in webhooks).
 */

/** A close that could not take everyone out: the group stays as it is. */
export class SubmissionGroupCloseIncompleteError extends Error {
  constructor(readonly remaining: number) {
    super(closeRemainingText(remaining));
    this.name = 'SubmissionGroupCloseIncompleteError';
  }
}

export function closeRemainingText(remaining: number): string {
  return `${remaining} ${remaining === 1 ? 'person' : 'people'} could not be removed from the WhatsApp group`;
}

const REMAINING_RE =
  /^(\d+) (?:person|people) could not be removed from the WhatsApp group$/;

/** How many people a stored close error says are still in the group; null when it says something else. */
export function closeRemaining(error: string | null): number | null {
  const m = error ? REMAINING_RE.exec(error) : null;
  return m ? Number(m[1]) : null;
}

/** Why a waiting create is not attempted: the customer may not be added. */
const CREATE_REFUSED = {
  optedOut: 'the customer opted out of messages',
  doNotContact: 'the customer is marked do not contact',
  noNumber: 'the customer has no phone number',
} as const;

export type CreateRefusedKey = keyof typeof CREATE_REFUSED;

/** What a create refused by the consent check stores, alone or after an unconfirmed count. */
export function createRefusedText(
  reason: 'opted_out' | 'do_not_contact' | undefined
): string {
  switch (reason) {
    case 'opted_out':
      return CREATE_REFUSED.optedOut;
    case 'do_not_contact':
      return CREATE_REFUSED.doNotContact;
    case undefined:
      return CREATE_REFUSED.noNumber;
  }
}

/** The consent reason a stored create error gives; null when it says something else. */
export function createRefused(error: string | null): CreateRefusedKey | null {
  if (!error) return null;
  for (const [key, text] of Object.entries(CREATE_REFUSED))
    if (error === text || error.endsWith(`: ${text}`))
      return key as CreateRefusedKey;
  return null;
}
