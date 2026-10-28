import type { InboxRow } from '@/lib/cases/ui';
import {
  inCampaignInbox,
  type CampaignInboxFields,
} from '@/lib/inbox/campaign-inbox';

// ------------------------------------------------------------
// The "Needs your attention" strip's counts and tile states.
// ------------------------------------------------------------

/**
 * Unread chats the Inbox lists: the sidebar dot's rule
 * (`useTotalUnread`), without its realtime channel.
 */
export function countInboxUnread(
  rows: readonly (CampaignInboxFields & { unread_count?: number | null })[],
  aiLive: boolean
): number {
  let n = 0;
  for (const row of rows) {
    if ((row.unread_count ?? 0) > 0 && !inCampaignInbox(row, aiLive)) n += 1;
  }
  return n;
}

/** Open cases past their SLA, and how many of those have the customer waiting. */
export function overdueCases(
  rows: readonly Pick<InboxRow, 'slaState' | 'customerWaiting'>[]
): { overdue: number; waiting: number } {
  let overdue = 0;
  let waiting = 0;
  for (const row of rows) {
    if (row.slaState !== 'overdue') continue;
    overdue += 1;
    if (row.customerWaiting) waiting += 1;
  }
  return { overdue, waiting };
}

/** What a tile shows. */
export type TileState = 'loading' | 'error' | 'clear' | 'alert';

/**
 * A count on screen wins (one kept from an earlier load stays through a
 * failed refresh); without one, an error reads "–" and anything else is
 * still loading. Zero is calm, anything more takes the tile's tone.
 */
export function tileState(count: number | null, error: boolean): TileState {
  if (count === null) return error ? 'error' : 'loading';
  return count > 0 ? 'alert' : 'clear';
}

/** A tile's figure: "12", or "12+" when the source list was cut short. */
export function formatCount(count: number, truncated = false): string {
  return truncated ? `${count}+` : String(count);
}
