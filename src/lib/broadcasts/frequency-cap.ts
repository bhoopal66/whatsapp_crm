// ============================================================
// The frequency cap: "Skip people messaged in the last N days".
//
// Decided twice. When a campaign is built (use-broadcast-sending.ts)
// nobody in the window, and nobody another campaign is about to message,
// gets a row; when it is sent (broadcast-core.ts) each recipient is
// asked about again, because what other campaigns did meanwhile could
// not be known then. Client-safe.
// ============================================================

const DAY_MS = 86_400_000;

/** A recipient row at or past 'sent'. A failed send messaged nobody. */
export const MESSAGED_STATUSES = ['sent', 'delivered', 'read', 'replied'];

/** Campaign statuses whose pending recipients may still be messaged. */
export const PENDING_CAMPAIGN_STATUSES = ['scheduled', 'sending'];

/** How long the cron goes on with an unfinished campaign (its own rule). */
const SENDING_GIVEN_UP_AFTER_DAYS = 7;

export function capCutoff(days: number, now: number = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString();
}

export interface PendingCampaign {
  status: string;
  scheduled_at: string | null;
  created_at: string;
}

/**
 * Whether a campaign's pending recipients are still to be messaged. One
 * left 'sending' past the cron's week was abandoned: it must not hold
 * its people back for ever.
 */
export function willStillSend(
  campaign: PendingCampaign,
  now: number = Date.now()
): boolean {
  if (campaign.status === 'scheduled') return true;
  if (campaign.status !== 'sending') return false;
  const since = Date.parse(campaign.scheduled_at ?? campaign.created_at);
  return since >= now - SENDING_GIVEN_UP_AFTER_DAYS * DAY_MS;
}

/** The failure reason stamped on a recipient the cap skips at delivery. */
export function frequencyCapReason(days: number): string {
  return `Skipped: messaged by another campaign in the last ${days} ${days === 1 ? 'day' : 'days'}`;
}
