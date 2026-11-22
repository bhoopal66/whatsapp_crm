/**
 * The optional "new customer message" sound (OFF by default). Pure
 * decisions only; `components/layout/message-sound.ts` plays the tone
 * and `unread-chats-provider.tsx` calls these.
 *
 * The signal is the unread mirror the sidebar already keeps
 * (`useUnreadChats`): a conversation's `unread_count` only goes up
 * through `bump_conversation_on_inbound` (a customer's message), so a
 * rise is a new customer message in a chat RLS shows this person, and
 * the person's own sends never cause one.
 */

import {
  inCampaignInbox,
  type CampaignInboxFields,
} from '@/lib/inbox/campaign-inbox';
import {
  isOthersPersonalChat,
  type PersonalChatRow,
} from '@/lib/inbox/personal-chats';

/** At most one sound this often, however many messages arrive. */
export const MESSAGE_SOUND_THROTTLE_MS = 3_000;

/**
 * Where the switch is kept: this browser, per signed-in person. A sound
 * is a device matter (a shared desk PC, a muted laptop), and no
 * per-user server preference fits it without a migration.
 */
export function messageSoundKey(userId: string): string {
  return `taamul.tab-alerts.message-sound:${userId}`;
}

/** Did an unread count go up (a missing count reads as 0)? */
export function unreadRose(
  previous: number | null | undefined,
  next: number | null | undefined
): boolean {
  return (next ?? 0) > (previous ?? 0);
}

/**
 * Chats whose new message is worth a sound: not a campaign chat the bot
 * is answering (the Inbox does not list it), not someone else's
 * personal chat (191; a leader or admin can see it but does not work it).
 */
export function soundWorthyChat(
  row: CampaignInboxFields & PersonalChatRow,
  aiLive: boolean,
  viewerId: string | null
): boolean {
  return !inCampaignInbox(row, aiLive) && !isOthersPersonalChat(row, viewerId);
}

/** The routes that render the inbox and open a chat from `?c=<id>`. */
const INBOX_ROUTES: readonly string[] = [
  '/inbox',
  '/team-inbox',
  '/hr/recruiter',
  '/hr/department',
  '/hr/unsorted',
  '/broadcasts/inbox',
];

/** The chat open on this page, or null when no inbox chat is open. */
export function openChatId(
  pathname: string | null | undefined,
  search: string | null | undefined
): string | null {
  const path = (pathname ?? '').replace(/\/+$/, '');
  if (!INBOX_ROUTES.includes(path)) return null;
  const id = new URLSearchParams(search ?? '').get('c');
  return id ? id : null;
}

export interface MessageSoundInput {
  /** The person's switch on this browser. */
  enabled: boolean;
  /** The chat the new message is in. */
  conversationId: string;
  /** The chat open in this tab, if any (`openChatId`). */
  openConversationId: string | null;
  /** The tab is visible and has focus. */
  tabFocused: boolean;
  now: number;
  /** When this tab last played the sound, or null. */
  lastPlayedAt: number | null;
}

export function shouldPlayMessageSound(input: MessageSoundInput): boolean {
  if (!input.enabled) return false;
  // The person is looking at that very chat: the message is on screen.
  if (input.tabFocused && input.openConversationId === input.conversationId)
    return false;
  if (
    input.lastPlayedAt !== null &&
    input.now - input.lastPlayedAt < MESSAGE_SOUND_THROTTLE_MS
  )
    return false;
  return true;
}
