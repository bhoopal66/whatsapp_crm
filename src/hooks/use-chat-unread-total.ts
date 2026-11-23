'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { subscribeChat, unreadCounts, type UnreadCount } from '@/lib/chat';
import { totalUnread } from '@/lib/chat/view';
import { startLiveRead } from '@/lib/realtime/catch-up';
import { createClient } from '@/lib/supabase/client';

/** Re-read at most this often while chat events stream in. */
const REFRESH_DEBOUNCE_MS = 800;

/**
 * Unread team-chat messages over every channel, for the nav badge; a
 * muted channel counts only its mentions (totalUnread). Its own
 * realtime channel (like useTotalUnread): a message, a read marker or a
 * mute (a membership UPDATE from chat_mark_read or chat_set_muted)
 * re-reads the counts, so the SQL stays the one definition of "unread".
 */
export function useChatUnreadTotal(): number {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const [counts, setCounts] = useState<UnreadCount[]>([]);

  useEffect(() => {
    if (!userId || !accountId) return;
    const sb = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Also read again after a gap in realtime. A badge is not worth an
    // error toast: a failed read is retried quietly.
    const live = startLiveRead({
      read: () => unreadCounts(sb, accountId),
      apply: setCounts,
    });
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(live.refresh, REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeChat(sb, {
      accountId,
      userId,
      onMessage: schedule,
      onMember: schedule,
      onChannel: schedule,
      onStatus: live.onStatus,
    });
    return () => {
      live.stop();
      clearTimeout(timer);
      unsubscribe();
    };
  }, [userId, accountId]);

  return totalUnread(counts);
}
