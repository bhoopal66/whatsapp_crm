'use client';

import { useCallback, useEffect, useRef } from 'react';

import type { ChatWorkspace } from '@/hooks/use-chat-workspace';
import { markRead, type ChannelMember } from '@/lib/chat';
import { markLanded, shouldMarkRead } from '@/lib/chat/read-mark';

export const MARK_READ_DEBOUNCE_MS = 800;

/**
 * Marks sent whose echo has not come back, per person and channel: a
 * channel and its thread are open side by side, and the second must not
 * take back the first one's mark.
 */
const sentMarks = new Map<string, string>();

export interface MarkReadInput {
  channelId: string;
  membership: Pick<ChannelMember, 'lastReadAt'> | null | undefined;
  /** The newest shown message's `createdAt`; null when there is none. */
  at: string | null;
  ready: boolean;
  /** Asked as the mark falls due, not when it is scheduled. Stable. */
  mayMark: () => boolean;
  /** A change of it asks again (`mayMark` cannot say it changed). */
  version?: unknown;
}

/**
 * Marks what is shown read, MARK_READ_DEBOUNCE_MS after it last changed
 * or the tab came back into view, under `shouldMarkRead`'s rules. Returns
 * a stable `recheck`, which starts that wait again.
 */
export function useMarkRead(
  ws: Pick<ChatWorkspace, 'sb' | 'userId' | 'refreshUnread'>,
  { channelId, membership, at, ready, mayMark, version }: MarkReadInput
): () => void {
  const { sb, userId, refreshUnread } = ws;
  // Whether there is a row and its mark, never the row itself: each
  // mark's own echo is a new row object.
  const member = !!membership;
  const held = membership?.lastReadAt ?? null;
  const schedule = useRef<(() => void) | null>(null);

  useEffect(() => {
    const sentKey = `${userId}:${channelId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const due = () => {
      let sent = sentMarks.get(sentKey);
      // From here the member row says it, and may be wound back elsewhere.
      if (sent && markLanded(held, sent)) {
        sentMarks.delete(sentKey);
        sent = undefined;
      }
      const visible = document.visibilityState === 'visible';
      if (!at || !shouldMarkRead({ ready, member, visible, at, held, sent }))
        return;
      if (!mayMark()) return;
      sentMarks.set(sentKey, at);
      markRead(sb, channelId, at)
        .then(refreshUnread)
        .catch(() => {
          // Let the next change or visit try again.
          if (sentMarks.get(sentKey) !== at) return;
          if (sent) sentMarks.set(sentKey, sent);
          else sentMarks.delete(sentKey);
        });
    };
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(due, MARK_READ_DEBOUNCE_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') wait();
    };
    schedule.current = wait;
    wait();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      schedule.current = null;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [
    sb,
    userId,
    refreshUnread,
    channelId,
    member,
    held,
    at,
    ready,
    mayMark,
    version,
  ]);

  return useCallback(() => schedule.current?.(), []);
}
