// ============================================================
// What a stored Compass notification says about itself. Pure and
// client-safe: the API (notify.ts) and the dashboard's Compass screen
// read the same rows and must not disagree.
// ============================================================

/** A `sending` claim older than this is presumed dead and may be retried. */
export const STALE_CLAIM_MS = 2 * 60_000;

/** `error_code` of a row handed to WhatsApp whose outcome is not known. */
export const DELIVERY_UNCONFIRMED = 'delivery_unconfirmed';

interface StoredClaim {
  status: string;
  updated_at: string;
  error_code?: string | null;
}

/**
 * May a stored claim be taken over by a retry? `sent` never; `failed`
 * always; `sending` only once it has been abandoned; neither when the
 * message may already be with WhatsApp.
 */
export function isClaimRetryable(row: StoredClaim, now = Date.now()): boolean {
  if (row.error_code === DELIVERY_UNCONFIRMED) return false;
  if (row.status === 'failed') return true;
  if (row.status === 'sending') {
    return now - new Date(row.updated_at).getTime() > STALE_CLAIM_MS;
  }
  return false;
}

/**
 * Handed to WhatsApp and the outcome never learned. A marked `sending`
 * row that is still fresh is a live send, not this.
 */
export function isUnconfirmed(row: StoredClaim, now = Date.now()): boolean {
  return (
    row.error_code === DELIVERY_UNCONFIRMED &&
    isClaimRetryable({ ...row, error_code: null }, now)
  );
}

export const NOTIFICATION_STATUSES = ['sending', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * The PostgREST `or` filter for the rows `serializeNotification` shows
 * with this status: a stuck `sending` row counts as failed.
 */
export function notificationStatusFilter(
  status: NotificationStatus,
  now = Date.now()
): string {
  const cutoff = new Date(now - STALE_CLAIM_MS).toISOString();
  switch (status) {
    case 'sent':
      return 'status.eq.sent';
    case 'failed':
      return `status.eq.failed,and(status.eq.sending,error_code.eq.${DELIVERY_UNCONFIRMED},updated_at.lt.${cutoff})`;
    case 'sending':
      return `and(status.eq.sending,or(error_code.is.null,updated_at.gte.${cutoff}))`;
  }
}
