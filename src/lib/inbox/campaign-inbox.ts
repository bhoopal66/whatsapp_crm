import type { Conversation } from '@/types';

/** The columns the rule reads. */
export type CampaignInboxFields = Pick<
  Conversation,
  | 'campaign_broadcast_id'
  | 'human_engaged_at'
  | 'assigned_agent_id'
  | 'ai_autoreply_disabled'
  | 'ai_reply_count'
  | 'chat_tag_id'
>;

/**
 * Whether the bot is answering this chat — which decides which of the
 * two lists it is in. The Campaign inbox under Broadcasts holds exactly
 * these chats and the Inbox holds every other one, so each chat is in
 * one place (migration 067).
 *
 * The bot is answering a chat that came from a campaign (048) while
 * the AI auto-reply is live (`aiLive`, from `ai_auto_reply_live()`),
 * the AI has replied in it, it has not handed it off or been paused on
 * it, and no person has stepped in. A person stepping in — an
 * assignment, or a person's reply — sets `human_engaged_at` for good,
 * so that chat stays in the Inbox from then on. A chat tag moves it
 * too, for as long as the chat carries one: tagging is how a person
 * files a chat, and a filed chat is the people's. Requiring an AI reply
 * is the safety net: a campaign reply the bot never answers (one on a
 * number it does not run on, or the bot switched off) stays in the
 * Inbox, where a person will see it.
 *
 * The lists query with {@link CAMPAIGN_INBOX_FILTER} and
 * {@link INBOX_FILTER}, and re-apply this to rows realtime adds or
 * patches; the three must agree (campaign-inbox.test.ts holds them to
 * it). The database stamps `human_engaged_at` on every assignment, so
 * checking `assigned_agent_id` too changes no answer there — it lets a
 * chat assigned on this screen move before the realtime update lands.
 */
export function inCampaignInbox(
  conversation: CampaignInboxFields,
  aiLive: boolean
): boolean {
  return (
    aiLive &&
    !!conversation.campaign_broadcast_id &&
    !conversation.human_engaged_at &&
    !conversation.assigned_agent_id &&
    !conversation.ai_autoreply_disabled &&
    (conversation.ai_reply_count ?? 0) > 0 &&
    !conversation.chat_tag_id
  );
}

/**
 * {@link inCampaignInbox} as a PostgREST `or` group (one `and(...)`
 * term), for the Campaign inbox query while the AI is live. With the
 * AI off the Campaign inbox is empty and is not queried at all.
 */
export const CAMPAIGN_INBOX_FILTER =
  'and(campaign_broadcast_id.not.is.null,human_engaged_at.is.null,assigned_agent_id.is.null,ai_autoreply_disabled.is.false,ai_reply_count.gt.0,chat_tag_id.is.null)';

/**
 * The negation of {@link CAMPAIGN_INBOX_FILTER}, for the Inbox query
 * while the AI is live. With the AI off nothing is the bot's, and the
 * Inbox applies no filter.
 */
export const INBOX_FILTER =
  'campaign_broadcast_id.is.null,human_engaged_at.not.is.null,assigned_agent_id.not.is.null,ai_autoreply_disabled.is.true,ai_reply_count.lte.0,chat_tag_id.not.is.null';
