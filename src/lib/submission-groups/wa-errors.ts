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
