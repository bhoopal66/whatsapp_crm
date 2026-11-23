import { startCatchUp, type LiveRead } from '@/lib/realtime/catch-up';

import { mergeMessages } from './group-page';

/**
 * What an open group chat does about the gaps realtime leaves (sleep, a
 * dropped connection), shared by the WhatsApp group and the submission
 * group chat.
 */

/** A bubble of this browser's, not a row: kept whatever a page says. */
export const isTempMessageId = (id: string) => id.startsWith('tmp-');

export interface ChatLog<T> {
  messages: T[];
  hasMore: boolean;
}

/**
 * The newest page, put into what is held. It joins only when nothing can
 * be missing in between: its oldest row is held, or it is the whole log.
 * A row in common is not enough, since one that arrived after the gap is
 * in both. Otherwise it replaces what is held, all but the sends on
 * their way and what arrived while it was being read.
 */
export function joinFreshPage<T extends { id: string; created_at: string }>(
  held: ChatLog<T>,
  page: ChatLog<T>
): ChatLog<T> {
  const oldest = page.messages[0];
  const joins =
    !!oldest && page.hasMore && held.messages.some((m) => m.id === oldest.id);
  if (joins || !page.hasMore) {
    return {
      messages: mergeMessages(held.messages, page.messages),
      hasMore: joins && held.hasMore,
    };
  }
  const newest = page.messages.at(-1)?.created_at ?? '';
  const kept = held.messages.filter(
    (m) =>
      isTempMessageId(m.id) || Date.parse(m.created_at) > Date.parse(newest)
  );
  return {
    messages: mergeMessages(kept, page.messages),
    hasMore: page.hasMore,
  };
}

/**
 * Reads the chat again after a gap (`startCatchUp`: joined again, shown
 * after a long hide; here also back online), and pays a read mark owed
 * from while the tab was hidden once it is shown. Call it in the effect
 * that opens the channel: pass `onStatus` to `subscribe`, `stop` in the
 * cleanup.
 */
export function startChatCatchUp({
  refresh,
  settle,
}: {
  /** Rejects when the read failed. False: nothing to mark read. */
  refresh: () => Promise<boolean>;
  /** A read fell due (`true`), or one owed may be payable (`false`). */
  settle: (due: boolean) => void;
}): LiveRead {
  let stopped = false;
  const live = startCatchUp(async () => {
    const readable = await refresh();
    if (readable && !stopped) settle(true);
  });
  const onVisibility = () => settle(false);
  window.addEventListener('online', live.catchUp);
  document.addEventListener('visibilitychange', onVisibility);
  return {
    ...live,
    stop: () => {
      stopped = true;
      window.removeEventListener('online', live.catchUp);
      document.removeEventListener('visibilitychange', onVisibility);
      live.stop();
    },
  };
}
