import type { InboxRow } from '@/lib/cases/ui';
import {
  inMainInbox,
  type DepartmentChatRow,
  type InboxDepartment,
} from '@/lib/inbox/departments';
import {
  isOthersPersonalChat,
  type PersonalChatRow,
} from '@/lib/inbox/personal-chats';
import {
  inCampaignInbox,
  type CampaignInboxFields,
} from '@/lib/inbox/campaign-inbox';

// ------------------------------------------------------------
// The "Needs your attention" strip's counts and tile states.
// ------------------------------------------------------------

/**
 * Unread chats, by the sidebar's rule (`useUnreadChats`) without its
 * realtime channel. Not narrowed for a team leader: their tile opens
 * the Team inbox (`inboxHrefFor`), so it matches that count. Other
 * people's personal chats (191) stay out too, except in `wideView` (the
 * Team inbox lists them, so the tile must count them); department chats
 * that are not the viewer's own (192) stay out in both, as in the list,
 * except (below admin) those of the viewer's own department,
 * `ownDepartment`.
 */
export function countInboxUnread(
  rows: readonly (CampaignInboxFields &
    PersonalChatRow &
    DepartmentChatRow & { unread_count?: number | null })[],
  aiLive: boolean,
  userId: string | null,
  wideView = false,
  ownDepartment: InboxDepartment | null = null
): number {
  let n = 0;
  for (const row of rows) {
    if ((row.unread_count ?? 0) <= 0) continue;
    if (inCampaignInbox(row, aiLive)) continue;
    if (!wideView && isOthersPersonalChat(row, userId)) continue;
    if (!inMainInbox(row, userId, ownDepartment)) continue;
    n += 1;
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
 * `also` is a second, separate set the tile reports in its hint: it
 * keeps the tile out of "All clear" without changing the figure.
 */
export function tileState(
  count: number | null,
  error: boolean,
  also = 0
): TileState {
  if (count === null) return error ? 'error' : 'loading';
  return count > 0 || also > 0 ? 'alert' : 'clear';
}

/**
 * Where the chat tiles go. The counts come through RLS, which hands a
 * team leader every chat of their team, but `/inbox` narrows a leader to
 * their own threads; `/team-inbox` shows what the counts counted.
 */
export function inboxHrefFor(role: string | null | undefined): string {
  return role === 'team_leader' ? '/team-inbox' : '/inbox';
}

/** A tile's figure: "12", or "12+" when the source list was cut short. */
export function formatCount(count: number, truncated = false): string {
  return truncated ? `${count}+` : String(count);
}
