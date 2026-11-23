/**
 * The messages one open submission group's chat holds: the newest page,
 * read again on every live update, and the older pages the reader loaded.
 */
import type { SgDetail, SgMessage, SgOlderPage } from './ui';

export interface SgChatLog {
  messages: SgMessage[];
  /** For the page before the oldest held row; null: nothing is older. */
  olderCursor: string | null;
}

export const EMPTY_CHAT_LOG: SgChatLog = { messages: [], olderCursor: null };

/**
 * The newest page, put into what is held. Older rows are kept only when
 * nothing can be missing in between: the page's oldest row is held (as in
 * `joinFreshPage` of the WhatsApp groups). Within the page the page is
 * right: every row here came from a read, none from this browser. An ENDED
 * group answers no messages, and none of its old ones may stay on screen.
 */
export function withFreshPage(
  held: SgChatLog,
  page: Pick<SgDetail, 'messages' | 'older_cursor'>
): SgChatLog {
  const fresh = { messages: page.messages, olderCursor: page.older_cursor };
  const oldest = page.messages[0];
  if (!oldest || page.older_cursor === null) return fresh;
  const at = held.messages.findIndex((m) => m.id === oldest.id);
  if (at <= 0) return fresh;
  return {
    messages: [...held.messages.slice(0, at), ...page.messages],
    olderCursor: held.olderCursor,
  };
}

/**
 * The older page read from cursor `before`. A fresh page may have replaced
 * the log meanwhile; those rows then no longer join it, so it is left as is.
 */
export function withOlderPage(
  held: SgChatLog,
  before: string,
  page: Pick<SgOlderPage, 'messages' | 'older_cursor'>
): SgChatLog {
  if (held.olderCursor !== before) return held;
  return {
    messages: [...page.messages, ...held.messages],
    olderCursor: page.older_cursor,
  };
}

/** Where to scroll so what was on screen stays put once rows went in above. */
export function keptScrollTop(
  before: { top: number; height: number },
  height: number
): number {
  return before.top + (height - before.height);
}
