// ============================================================
// Where a thread's "N unread messages" divider goes.
//
// `conversations.unread_count` counts customer messages only (the
// inbound pipeline bumps it), so the divider sits above the oldest of
// the last `unreadCount` customer messages — our own replies and the
// bot's are never "unread" and are skipped while counting. Pure, so
// the counting rules are testable without a DOM.
// ============================================================

import type { Message } from '@/types';

/**
 * The id of the first unread message, or null when nothing is unread.
 *
 * When fewer customer messages are loaded than the count (the rest sit
 * in an older page), the oldest loaded one is the best place we have:
 * everything below it is unread.
 */
export function firstUnreadMessageId(
  messages: readonly Pick<Message, 'id' | 'sender_type'>[],
  unreadCount: number
): string | null {
  if (unreadCount <= 0) return null;
  let found: string | null = null;
  let counted = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender_type !== 'customer') continue;
    found = messages[i].id;
    counted += 1;
    if (counted === unreadCount) break;
  }
  return found;
}
