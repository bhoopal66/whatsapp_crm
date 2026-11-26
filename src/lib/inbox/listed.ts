import { inCampaignInbox, type CampaignInboxFields } from './campaign-inbox';
import {
  inMainInbox,
  type DepartmentChatRow,
  type InboxDepartment,
} from './departments';
import { isOthersPersonalChat, type PersonalChatRow } from './personal-chats';

/** The columns {@link isListedInInbox} reads from a chat. */
export type ListedChatRow = CampaignInboxFields &
  PersonalChatRow &
  DepartmentChatRow;

/**
 * Does the Inbox (or, with `wideView`, the Team inbox) list this chat?
 * The one rule behind every home count that opens an inbox list: unread,
 * Hot, Upset and Pinned must agree with the list they link to, so they
 * share it. Not in the Campaign inbox while the AI is live; someone
 * else's personal chat (191) stays out unless the Team inbox lists it
 * (`wideView`); a department chat (192) is the viewer's own, or of their
 * own department (`ownDepartment`).
 */
export function isListedInInbox(
  row: ListedChatRow,
  aiLive: boolean,
  userId: string | null,
  wideView = false,
  ownDepartment: InboxDepartment | null = null
): boolean {
  if (inCampaignInbox(row, aiLive)) return false;
  if (!wideView && isOthersPersonalChat(row, userId)) return false;
  return inMainInbox(row, userId, ownDepartment);
}
