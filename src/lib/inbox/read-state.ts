// ============================================================
// When the open chat counts as read.
//
// Only while its tab is on screen: a chat left open in a hidden tab
// used to mark every new message read with nobody looking.
// ============================================================

import type { Message } from '@/types';

export const UNREAD_RESET_RETRY_MS = 3_000;

/** Whether to zero the open chat's unread count on the server. */
export function shouldMarkRead(chat: {
  conversationId: string | undefined;
  /** `unreadResetKey`: null when there is nothing unread. */
  unreadKey: string | null;
  visible: boolean;
}): boolean {
  return !!chat.conversationId && chat.unreadKey !== null && chat.visible;
}

/**
 * What the reset depends on: a new value for every change of an unread
 * chat, null once it is read. "Is it unread" alone was not enough: our
 * reset and the next message can reach the screen in one render (0, then
 * 1), which never looks read, and the count then stayed up, and grew,
 * until the tab was hidden or the chat reopened.
 */
export function unreadResetKey(
  chat: { unread_count?: number | null; updated_at?: string | null } | null
): string | null {
  const unread = chat?.unread_count ?? 0;
  return unread > 0 ? `${unread}@${chat?.updated_at ?? ''}` : null;
}

/** A list row's unread count after a realtime message INSERT in it. */
export function unreadAfterInsert(
  current: number,
  message: Pick<Message, 'sender_type'>,
  chat: { isOpen: boolean; visible: boolean }
): number {
  if (!chat.isOpen) return current + 1;
  if (chat.visible) return 0;
  // Open but hidden: our own side's messages are never unread here, as
  // no conversation UPDATE need follow to correct the count.
  return message.sender_type === 'customer' ? current + 1 : current;
}

/** A list row's unread count after a realtime conversation UPDATE. */
export function unreadAfterUpdate(
  incoming: number,
  chat: { isOpen: boolean; visible: boolean }
): number {
  return chat.isOpen && chat.visible ? 0 : incoming;
}

/** `list` with one chat's count zeroed; the same array if it is 0. */
export function zeroUnreadOf<T extends { id: string; unread_count: number }>(
  list: T[],
  conversationId: string | null | undefined
): T[] {
  if (!list.some((c) => c.id === conversationId && c.unread_count > 0)) {
    return list;
  }
  return list.map((c) =>
    c.id === conversationId ? { ...c, unread_count: 0 } : c
  );
}

/**
 * Try the server reset now and, if it fails, once more after `delayMs`.
 * `attempt` answers whether it worked. Returns a cancel: a chat that was
 * left or hidden meanwhile must not be marked read later.
 */
export function startUnreadReset(
  attempt: () => Promise<boolean>,
  delayMs: number = UNREAD_RESET_RETRY_MS
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (retry: boolean) => {
    const ok = await attempt().catch(() => false);
    if (ok || cancelled || !retry) return;
    timer = setTimeout(() => void run(false), delayMs);
  };
  void run(true);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
