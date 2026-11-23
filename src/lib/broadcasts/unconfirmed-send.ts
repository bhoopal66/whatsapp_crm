// ============================================================
// Campaign sends whose outcome nobody knows.
//
// A timeout, a 5xx or a restart mid-send leaves open whether WhatsApp
// delivered the message. Such a recipient is stamped 'failed' with one
// of these two reasons and is never sent to again, by Resume, Retry
// failed or the cron: a campaign message cannot be recalled.
//
// The two texts are matched inside a PostgREST `or=` filter: no commas,
// colons or quotes in them. Client-safe (the campaign page reads it).
// ============================================================

/**
 * The gateway never answered, or answered in a way that leaves the send
 * open. Also the write-ahead mark: it is on the row BEFORE the send, so a
 * row still 'pending' with it was being sent when a pass died.
 */
export const SEND_UNCONFIRMED_REASON =
  'May have been sent - WhatsApp did not confirm it so it is not sent again';

/** WhatsApp accepted the send; the row could not be stamped 'sent'. */
export const SENT_NOT_RECORDED_REASON =
  'May have been sent - WhatsApp accepted it but it could not be recorded';

/**
 * `.or(…)` filter for the rows a pass may still send to. The null arm is
 * needed: `NOT IN` is not true of a null reason.
 */
export const RESENDABLE_FILTER = `error_message.is.null,error_message.not.in.("${SEND_UNCONFIRMED_REASON}","${SENT_NOT_RECORDED_REASON}")`;

export function isUnconfirmedSend(
  errorMessage: string | null | undefined
): boolean {
  return (
    errorMessage === SEND_UNCONFIRMED_REASON ||
    errorMessage === SENT_NOT_RECORDED_REASON
  );
}
