/**
 * How the Inbox writes the open chat (`?c=`) into the browser history.
 *
 * Side by side (lg and up) the list never leaves the screen, so every
 * click replaces the URL. On a phone the chat covers the list, and the
 * phone's own Back must return to it: opening a chat from the list adds
 * an entry, moving from chat to chat replaces it.
 *
 * The added entry is marked in `history.state`, which survives a reload
 * and leaving the Inbox and coming back; Next copies its own keys into
 * the state it is given and keeps ours on a history traversal. A
 * `router.refresh()` may drop the mark: the header arrow then falls back
 * to replacing the URL, as it does for a chat opened by a link.
 */

/** Where the list and the chat stand side by side (Tailwind `lg`). */
export const TWO_PANE_QUERY = '(min-width: 1024px)';

const PUSHED_KEY = 'inboxChatPushed';

/** Is this history entry one the list added by opening a chat? */
export function isPushedChat(historyState: unknown): boolean {
  return (
    typeof historyState === 'object' &&
    historyState !== null &&
    (historyState as Record<string, unknown>)[PUSHED_KEY] === true
  );
}

export interface ChatUrlWrite {
  method: 'pushState' | 'replaceState';
  state: Record<string, true> | null;
}

/** The history write for opening a chat from the list, or another chat. */
export function chatUrlWrite(input: {
  /** List and chat side by side. */
  twoPane: boolean;
  /** A chat is open already. */
  chatOpen: boolean;
  /** The URL's `?c=`: a chat asked for that may not have opened. */
  urlChat: string | null;
  /** `window.history.state`. */
  historyState: unknown;
}): ChatUrlWrite {
  if (!input.twoPane && !input.chatOpen && !input.urlChat) {
    return { method: 'pushState', state: { [PUSHED_KEY]: true } };
  }
  return {
    method: 'replaceState',
    state: isPushedChat(input.historyState) ? { [PUSHED_KEY]: true } : null,
  };
}

export type ChatPopAction =
  { kind: 'none' } | { kind: 'close' } | { kind: 'open'; id: string };

/**
 * What a Back or Forward does to the open chat. Nothing side by side
 * (the desktop Inbox keeps its chat), and nothing on the way to another
 * screen, which unmounts this one.
 */
export function chatPopAction(input: {
  twoPane: boolean;
  /** This screen's path, and the path the traversal landed on. */
  screenPath: string;
  path: string;
  /** The landed URL's `?c=`. */
  urlChat: string | null;
  openId: string | null;
}): ChatPopAction {
  if (input.twoPane || input.path !== input.screenPath) return { kind: 'none' };
  // Even with no chat open: one may still be on its way.
  if (!input.urlChat) return { kind: 'close' };
  if (input.urlChat === input.openId) return { kind: 'none' };
  return { kind: 'open', id: input.urlChat };
}

/**
 * The chat a link asks for while the Inbox is already on screen (a bell,
 * a notification click, search): the list does not load again, so
 * nothing else opens it. Null when there is nothing to do: our own URL
 * writes are noted first (`handled`), the first list load opens its own
 * link, and a `?c=` React has not caught up with is not the one in the
 * address bar.
 */
export function linkToFollow(input: {
  /** `useSearchParams`' and the address bar's `?c=`. */
  urlChat: string | null;
  locationChat: string | null;
  /** The last `?c=` that was opened. */
  handled: string | null;
  listLoaded: boolean;
}): string | null {
  const { urlChat, locationChat, handled, listLoaded } = input;
  if (!urlChat || !listLoaded || urlChat === handled) return null;
  return urlChat === locationChat ? urlChat : null;
}
