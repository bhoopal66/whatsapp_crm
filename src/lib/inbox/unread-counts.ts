import { inCampaignInbox, type CampaignInboxFields } from './campaign-inbox';
import { inRestrictedInbox, type RestrictableRow } from './pagination';
import { isOthersPersonalChat, type PersonalChatRow } from './personal-chats';

/** What the counts read of a conversation row. */
export type UnreadCountRow = CampaignInboxFields &
  RestrictableRow &
  PersonalChatRow & { unread_count?: number | null };

/** A team leader's personal-inbox narrowing (`restrictToUserGroup`'s inputs). */
export interface InboxNarrowing {
  userId: string;
  channelIds: readonly string[];
  sharedConversationIds: readonly string[];
}

/**
 * Unread chats per list. A campaign chat the bot is answering is in the
 * Campaign inbox (migration 067), so neither count has it. `team` is
 * every other unread row RLS handed over; `inbox` is the same set,
 * narrowed when the Inbox narrows (a team leader's). Someone else's
 * personal chat (191) is in `team` only: the Inbox never lists it.
 */
export function countUnreadChats(
  rows: Iterable<UnreadCountRow>,
  aiLive: boolean,
  narrowing: InboxNarrowing | null,
  viewerId: string | null = null
): { inbox: number; team: number } {
  let inbox = 0;
  let team = 0;
  for (const row of rows) {
    if ((row.unread_count ?? 0) <= 0 || inCampaignInbox(row, aiLive)) continue;
    team += 1;
    if (isOthersPersonalChat(row, viewerId)) continue;
    if (
      !narrowing ||
      inRestrictedInbox(
        row,
        narrowing.userId,
        narrowing.channelIds,
        narrowing.sharedConversationIds
      )
    )
      inbox += 1;
  }
  return { inbox, team };
}
