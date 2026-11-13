import { inCampaignInbox, type CampaignInboxFields } from './campaign-inbox';
import {
  inDepartmentInbox,
  inMainInbox,
  type DepartmentChatRow,
  type InboxDepartment,
} from './departments';
import { inRestrictedInbox, type RestrictableRow } from './pagination';
import { isOthersPersonalChat, type PersonalChatRow } from './personal-chats';

/** What the counts read of a conversation row. */
export type UnreadCountRow = CampaignInboxFields &
  RestrictableRow &
  PersonalChatRow &
  DepartmentChatRow & { unread_count?: number | null };

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
 * A department chat (192) is in neither, unless it is the viewer's own
 * or (below admin) of the viewer's own department, `ownDepartment`
 * (`inMainInbox`); {@link countDepartmentUnread} counts it instead.
 */
export function countUnreadChats(
  rows: Iterable<UnreadCountRow>,
  aiLive: boolean,
  narrowing: InboxNarrowing | null,
  viewerId: string | null = null,
  ownDepartment: InboxDepartment | null = null
): { inbox: number; team: number } {
  let inbox = 0;
  let team = 0;
  for (const row of rows) {
    if ((row.unread_count ?? 0) <= 0 || inCampaignInbox(row, aiLive)) continue;
    if (!inMainInbox(row, viewerId, ownDepartment)) continue;
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

/**
 * Unread chats in one department's inbox (migration 192), under the
 * same campaign rule as the main counts: the list leaves a campaign chat
 * the bot is answering to the Campaign inbox.
 */
export function countDepartmentUnread(
  rows: Iterable<UnreadCountRow>,
  aiLive: boolean,
  department: InboxDepartment
): number {
  let count = 0;
  for (const row of rows) {
    if ((row.unread_count ?? 0) <= 0 || inCampaignInbox(row, aiLive)) continue;
    if (inDepartmentInbox(row, department)) count += 1;
  }
  return count;
}
